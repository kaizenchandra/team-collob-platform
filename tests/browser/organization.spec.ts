import {
  test,
  expect,
  chromium,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { randomUUID } from "node:crypto";
import pg from "pg";
import AxeBuilder from "@axe-core/playwright";
const api = "http://localhost:4100/v1",
  org = randomUUID(),
  foreignOrg = randomUUID(),
  headers = { origin: "http://localhost:3101" },
  base = `${api}/organizations/${org}/organization`,
  connectionString =
    "postgres://concord:local-development-only@localhost:55432/concord";
const make = (name: string, title = "", department = "", role = "member") => ({
  id: randomUUID(),
  email: `organization-${randomUUID()}@example.test`,
  name,
  title,
  department,
  role,
});
const viewer = make("Morgan Lee", "Engineering lead", "Engineering"),
  manager = make(
    "Riley Jordan",
    "Director of engineering",
    "Engineering",
    "owner",
  ),
  leader = make("Avery Chen", "Chief executive", "Executive"),
  peer = make("Morgan Lee", "Finance lead", "Finance"),
  long = make(
    "Taylor Singh — International Enterprise Engineering and Customer Collaboration",
    "Principal engineer",
    "Engineering",
  ),
  child = make("Casey Quinn", "Engineer", "Engineering"),
  unknown = make("Employee without reporting details"),
  secondRoot = make(
    "Second recorded leader",
    "Regional director",
    "Operations",
  ),
  hidden = make(
    "Confidential employee",
    "Confidential position",
    "Private department",
  ),
  hiddenManager = make("Private manager", "Private role", "Private department"),
  limited = make("Limited manager context", "Analyst", "Operations"),
  inactive = make("Inactive employee"),
  disabled = make("Former employee"),
  cycleA = make("Cycle employee A"),
  cycleB = make("Cycle employee B"),
  foreign = make(
    "Foreign employee",
    "Private foreign title",
    "Foreign department",
    "owner",
  );
const reports = Array.from({ length: 43 }, (_, n) =>
    make(`Report ${String(n).padStart(2, "0")}`, "Engineer", "Engineering"),
  ),
  chain = Array.from({ length: 23 }, (_, n) =>
    make(`Long chain ${String(n).padStart(2, "0")}`, "Leader", "Leadership"),
  );
const users = [
  viewer,
  manager,
  leader,
  peer,
  long,
  child,
  unknown,
  secondRoot,
  hidden,
  hiddenManager,
  limited,
  inactive,
  disabled,
  cycleA,
  cycleB,
  ...reports,
  ...chain,
];
async function db(fn: (db: pg.Pool) => Promise<void>) {
  const client = new pg.Pool({ connectionString });
  try {
    await fn(client);
  } finally {
    await client.end();
  }
}
test.beforeAll(async () => {
  await db(async (client) => {
    await client.query(
      "INSERT INTO organizations(id,name) VALUES($1,$2),($3,$4)",
      [
        org,
        `Organization verification ${org}`,
        foreignOrg,
        `Foreign organization ${org}`,
      ],
    );
    for (const u of [...users, foreign]) {
      const target = u === foreign ? foreignOrg : org;
      await client.query(
        "INSERT INTO users(id,email,name,title,password_hash) SELECT $1,$2,$3,$4,password_hash FROM users WHERE email=$5",
        [u.id, u.email, u.name, u.title, "alice@acme.test"],
      );
      await client.query(
        "INSERT INTO memberships(org_id,user_id,role,active) VALUES($1,$2,$3,$4)",
        [target, u.id, u.role, u !== inactive],
      );
    }
    await client.query("UPDATE users SET disabled=true WHERE id=$1", [
      disabled.id,
    ]);
    const assign = async (
      u: typeof viewer,
      boss: typeof viewer | null,
      status = "assigned",
      visibility = "workspace",
    ) =>
      client.query(
        "INSERT INTO organization_people(org_id,user_id,manager_id,reporting_status,department,organizational_unit,work_location,visibility,source_label,source_as_of) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'Approved test directory',now())",
        [
          org,
          u.id,
          boss?.id ?? null,
          status,
          u.department,
          u.department ? "Product division" : "",
          u === viewer ? "Bengaluru" : u === peer ? "London" : "",
          visibility,
        ],
      );
    await assign(leader, null, "root");
    await assign(secondRoot, null, "root");
    await assign(hiddenManager, null, "root", "restricted");
    await assign(manager, leader);
    await assign(viewer, manager);
    await assign(peer, manager);
    await assign(long, viewer);
    await assign(child, reports[0]);
    await assign(hidden, viewer, "assigned", "restricted");
    await assign(limited, hiddenManager);
    await assign(inactive, viewer);
    await assign(disabled, viewer);
    await assign(cycleA, cycleB);
    await assign(cycleB, cycleA);
    for (const p of reports) await assign(p, viewer);
    for (let i = 0; i < chain.length; i++)
      await assign(
        chain[i],
        chain[i + 1] ?? null,
        chain[i + 1] ? "assigned" : "root",
      );
  });
});
test.afterAll(async () => {
  await db(async (client) => {
    await client.query(
      "UPDATE memberships SET active=false WHERE org_id=ANY($1::uuid[])",
      [[org, foreignOrg]],
    );
    await client.query(
      "UPDATE users SET disabled=true WHERE id=ANY($1::uuid[])",
      [[...users, foreign].map((u) => u.id)],
    );
  });
});
async function login(c: BrowserContext, u = viewer) {
  const r = await c.request.post(`${api}/session`, {
    headers,
    data: { email: u.email, password: "Development123!" },
  });
  expect(r.status(), await r.text()).toBe(200);
}
async function open(p: Page) {
  await p.goto(`/?org=${org}`);
  await p.getByRole("button", { name: "Organization", exact: true }).click();
  await expect(p.locator(".org-selected-focus")).toContainText(viewer.name);
}
async function find(p: Page, text: string) {
  const disclosure = p.locator(".org-search-disclosure");
  if (!(await disclosure.evaluate((e) => (e as HTMLDetailsElement).open)))
    await disclosure.locator("summary").click();
  await p.getByLabel("Find employees", { exact: true }).fill(text);
}
async function select(p: Page, u: typeof viewer) {
  await find(p, u.name);
  const result = p
    .locator(".org-search-results li")
    .filter({ hasText: u.email });
  await result.getByRole("button").click();
  await expect(p.locator(".org-selected-focus")).toContainText(u.name);
}

test("organization APIs enforce visibility, tenancy, real reporting lines, counts, pagination and cycles", async ({
  browser,
}) => {
  test.setTimeout(60000);
  const a = await browser.newContext(),
    admin = await browser.newContext(),
    other = await browser.newContext();
  try {
    await login(a);
    await login(admin, manager);
    await login(other, foreign);
    const context = await (
      await a.request.get(`${base}/people/${viewer.id}`)
    ).json();
    expect(context.person.id).toBe(viewer.id);
    expect(context.person.directReportCount).toBe(44);
    expect(context.manager.id).toBe(manager.id);
    expect(context.chain.map((p: { id: string }) => p.id)).toEqual([
      leader.id,
      manager.id,
    ]);
    expect(context.chainStatus).toBe("complete");
    expect(JSON.stringify(context)).not.toContain("manager_id");
    let cursor: { name: string; id: string } | null = null;
    const all: string[] = [];
    do {
      const q = new URLSearchParams({ limit: "20" });
      if (cursor) {
        q.set("afterName", cursor.name);
        q.set("afterId", cursor.id);
      }
      const r = await a.request.get(`${base}/people/${viewer.id}/reports?${q}`);
      expect(r.status(), await r.text()).toBe(200);
      const data = await r.json();
      expect(data.people.length).toBeLessThanOrEqual(20);
      all.push(...data.people.map((p: { id: string }) => p.id));
      cursor = data.nextCursor;
    } while (cursor);
    expect(new Set(all).size).toBe(44);
    for (const p of [hidden, inactive, disabled])
      expect(all).not.toContain(p.id);
    const peers = await (
      await a.request.get(`${base}/people/${viewer.id}/peers`)
    ).json();
    expect(peers.people.map((p: { id: string }) => p.id)).toEqual([peer.id]);
    for (const p of [hidden, hiddenManager, inactive, disabled, foreign])
      for (const suffix of ["", "/profile", "/reports", "/peers"])
        expect(
          (await a.request.get(`${base}/people/${p.id}${suffix}`)).status(),
        ).toBe(404);
    expect(
      (await other.request.get(`${base}/people/${viewer.id}`)).status(),
    ).toBe(404);
    const results = await (
      await a.request.get(`${base}/people?q=Confidential`)
    ).json();
    expect(results.people).toEqual([]);
    const departments = await (
      await a.request.get(`${base}/departments`)
    ).json();
    expect(departments.departments).not.toContain("Private department");
    expect(
      (
        await (
          await a.request.get(`${api}/organizations/${org}/bootstrap`)
        ).json()
      ).people.map((p: { id: string }) => p.id),
    ).not.toContain(hidden.id);
    const restrictedManager = await (
      await a.request.get(`${base}/people/${limited.id}`)
    ).json();
    expect(restrictedManager.managerState).toBe("unavailable");
    expect(restrictedManager.manager).toBeNull();
    expect(restrictedManager.chain).toEqual([]);
    expect(JSON.stringify(restrictedManager)).not.toContain(hiddenManager.id);
    expect(
      (await (await a.request.get(`${base}/people/${limited.id}/peers`)).json())
        .people,
    ).toEqual([]);
    const unassigned = await (
      await a.request.get(`${base}/people/${unknown.id}`)
    ).json();
    expect(unassigned.managerState).toBe("unknown");
    expect(unassigned.person.updatedAt).toBeNull();
    expect(unassigned.person.department).toBe("");
    const roots = await (
      await a.request.get(`${base}/people?roots=true`)
    ).json();
    expect(roots.people.map((p: { id: string }) => p.id)).toEqual(
      expect.arrayContaining([leader.id, secondRoot.id, chain.at(-1)!.id]),
    );
    expect(roots.people.map((p: { id: string }) => p.id)).not.toContain(
      unknown.id,
    );
    const cycle = await (
      await a.request.get(`${base}/people/${cycleA.id}`)
    ).json();
    expect(cycle.chainStatus).toBe("cycle");
    expect(cycle.chain).toHaveLength(1);
    const deep = await (
      await a.request.get(`${base}/people/${chain[0].id}`)
    ).json();
    expect(deep.chainStatus).toBe("truncated");
    expect(deep.chain).toHaveLength(20);
    expect(
      (await (await a.request.get(`${base}/people/${chain[20].id}`)).json())
        .chainStatus,
    ).toBe("complete");
    expect(
      (await admin.request.get(`${base}/people/${hidden.id}`)).status(),
    ).toBe(200);
    expect(
      (await (await admin.request.get(`${base}/people/${viewer.id}`)).json())
        .person.directReportCount,
    ).toBe(45);
    for (const q of ["limit=51", "afterId=" + randomUUID(), "admin=true"])
      expect((await a.request.get(`${base}/people?${q}`)).status()).toBe(400);
    expect(
      (
        await a.request.patch(`${base}/people/${viewer.id}`, {
          headers,
          data: { managerId: peer.id },
        })
      ).status(),
    ).toBe(404);
    await db(async (client) => {
      await client.query(
        "UPDATE organization_people SET visibility='restricted' WHERE org_id=$1 AND user_id=$2",
        [org, reports[42].id],
      );
    });
    expect(
      (await (await a.request.get(`${base}/people/${viewer.id}`)).json()).person
        .directReportCount,
    ).toBe(43);
    expect(
      (
        await a.request.get(`${base}/people/${reports[42].id}/profile`)
      ).status(),
    ).toBe(404);
    await db(async (client) => {
      await client.query(
        "UPDATE organization_people SET visibility='workspace' WHERE org_id=$1 AND user_id=$2",
        [org, reports[42].id],
      );
      await client.query(
        "UPDATE memberships SET active=false WHERE org_id=$1 AND user_id=$2",
        [org, viewer.id],
      );
    });
    expect((await a.request.get(`${base}/people/${viewer.id}`)).status()).toBe(
      404,
    );
    expect((await a.request.get(`${base}/people?q=Report`)).status()).toBe(404);
    await db(async (client) => {
      await client.query(
        "UPDATE memberships SET active=true WHERE org_id=$1 AND user_id=$2",
        [org, viewer.id],
      );
    });
  } finally {
    await Promise.all([a.close(), admin.close(), other.close()]);
  }
});

test("organization navigation, progressive branches, profiles, search and readable responsive layouts", async ({
  browser,
}) => {
  test.setTimeout(90000);
  const c = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  try {
    await login(c);
    const p = await c.newPage();
    await p.goto(`/?org=${org}`);
    await p.getByRole("button", { name: "Account menu", exact: true }).hover();
    await p
      .getByRole("dialog", { name: "Account menu", exact: true })
      .getByRole("button", { name: "My organization", exact: true })
      .click();
    const selected = p.locator(".org-selected-focus");
    await expect(selected).toContainText(viewer.name);
    await expect(selected).toContainText("Selected employee");
    await expect(selected).toContainText("Bengaluru");
    await expect(
      p.getByRole("navigation", { name: "Reporting path", exact: true }),
    ).toContainText(leader.name);
    const rows = p.locator(
      ".org-reports>.org-employee-list>.org-report-cards>li",
    );
    await expect(rows).toHaveCount(20);
    const pages = p.getByRole("navigation", {
      name: `Direct reports pages for ${viewer.name}`,
      exact: true,
    });
    await pages.getByRole("button", { name: "Next", exact: true }).click();
    await expect(rows).toHaveCount(20);
    await pages.getByRole("button", { name: "Next", exact: true }).click();
    await expect(rows).toHaveCount(4);
    await pages
      .getByRole("button", { name: "First page", exact: true })
      .click();
    await expect(rows).toHaveCount(20);
    const expand = p.getByRole("button", {
      name: `Expand reports for ${reports[0].name}`,
      exact: true,
    });
    await expand.click();
    await expect(
      p.locator('.org-employee-list[aria-label="Direct reports of Report 00"]'),
    ).toContainText(child.name);
    await p
      .getByRole("button", { name: "Refresh organization", exact: true })
      .click();
    await expect(
      p.getByRole("button", {
        name: "Collapse reports for Report 00",
        exact: true,
      }),
    ).toHaveAttribute("aria-expanded", "true");
    await expect(
      p.locator('.org-employee-list[aria-label="Direct reports of Report 00"]'),
    ).toContainText(child.name);
    await p
      .getByRole("button", {
        name: "Collapse reports for Report 00",
        exact: true,
      })
      .click();
    await expect(
      p.locator('.org-employee-list[aria-label="Direct reports of Report 00"]'),
    ).toHaveCount(0);
    await p.getByRole("button", { name: "Show peers", exact: true }).click();
    const peers = p.getByRole("region", { name: "Peers", exact: true });
    await expect(peers).toContainText("Finance lead");
    await peers
      .getByRole("button", {
        name: `View organization for ${peer.name}`,
        exact: true,
      })
      .click();
    await expect(selected).toContainText("Finance lead");
    await p
      .getByRole("button", { name: "Previous employee", exact: true })
      .click();
    await expect(selected).toContainText("Engineering lead");
    await select(p, long);
    await expect(selected).toContainText(long.name);
    await expect(selected).toContainText("Principal engineer");
    await p.screenshot({ path: "docs/evidence/organization-desktop.png" });
    const profileTrigger = selected
      .getByRole("button", {
        name: `Profile details for ${long.name}`,
        exact: true,
      })
      .first();
    await profileTrigger.hover();
    const card = p.getByRole("dialog", {
      name: `Profile details for ${long.name}`,
      exact: true,
    });
    await expect(card).toBeVisible();
    await card.hover();
    await expect(card).toContainText("Engineering");
    await card
      .getByRole("button", { name: "View profile", exact: true })
      .click();
    await expect(
      card.getByText("Workspace role", { exact: true }),
    ).toBeVisible();
    await p.screenshot({ path: "docs/evidence/organization-profile.png" });
    await p.keyboard.press("Escape");
    await expect(card).toHaveCount(0);
    await profileTrigger.focus();
    await profileTrigger.press("Enter");
    await expect(card).toBeVisible();
    await p.keyboard.press("Escape");
    await expect(profileTrigger).toBeFocused();
    await p
      .getByRole("button", { name: "Accessible list view", exact: true })
      .click();
    await expect(
      p.getByRole("button", { name: "Chart view", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    for (const [width, height] of [
      [1366, 768],
      [834, 1194],
      [1194, 834],
      [390, 844],
      [640, 480],
    ]) {
      await p.setViewportSize({ width, height });
      await expect
        .poll(() =>
          p.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        )
        .toBe(true);
      await p
        .getByRole("button", { name: "Center selected employee", exact: true })
        .click();
      await p.screenshot({
        path: `docs/evidence/organization-${width}x${height}.png`,
      });
    }
    await p.setViewportSize({ width: 1440, height: 1000 });
    await p.evaluate(() => {
      document.documentElement.style.zoom = "2";
    });
    await expect
      .poll(() =>
        p.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      )
      .toBe(true);
    await p.getByRole("button", { name: "Back to me", exact: true }).click();
    await expect(selected).toContainText("Engineering lead");
    await p.screenshot({ path: "docs/evidence/organization-css-zoom-200.png" });
    await p.evaluate(() => {
      document.documentElement.style.zoom = "";
    });
    const axe = await new AxeBuilder({ page: p })
      .include(".org-explorer")
      .analyze();
    expect(axe.violations).toEqual([]);
    await p.getByRole("button", { name: "Back to me", exact: true }).click();
    await expect(selected).toContainText("Engineering lead");
    await p.getByRole("button", { name: "Chat", exact: true }).click();
    await p.getByRole("button", { name: "Organization", exact: true }).click();
    await expect(selected).toContainText("Engineering lead");
  } finally {
    await c.close();
  }
});

test("missing data, multiple roots, circular reporting and rapid employee/profile navigation stay honest", async ({
  browser,
}) => {
  test.setTimeout(60000);
  const c = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    hasTouch: true,
  });
  try {
    await login(c);
    const p = await c.newPage();
    await open(p);
    await select(p, unknown);
    await expect(p.locator(".org-manager-empty")).toContainText(
      "No primary manager assignment",
    );
    await expect(p.locator(".org-selected-focus")).toContainText(
      "Job title not provided",
    );
    await expect(p.locator(".org-reports")).toContainText(
      "No visible direct reports recorded.",
    );
    await select(p, secondRoot);
    await expect(p.locator(".org-manager-empty")).toContainText(
      "Recorded top-level leader",
    );
    await select(p, limited);
    await expect(p.locator(".org-manager-empty")).toContainText(
      "unavailable or restricted",
    );
    await expect(
      p.getByRole("button", { name: "Show peers", exact: true }),
    ).toBeDisabled();
    await select(p, cycleA);
    await expect(
      p.getByRole("status").filter({ hasText: "Circular reporting data" }),
    ).toBeVisible();
    await expect(p.locator(".org-reports")).toContainText(
      "Circular reporting relationship",
    );
    await p.screenshot({ path: "docs/evidence/organization-cycle.png" });
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await p.route(`**/organization/people/${long.id}`, async (route) => {
      try {
        const response = await route.fetch();
        await held;
        await route.fulfill({ response });
      } catch {
        await route.abort().catch(() => {});
      }
    });
    await find(p, long.name);
    await p
      .locator(".org-search-results li")
      .filter({ hasText: long.email })
      .getByRole("button")
      .click();
    await p
      .getByRole("button", { name: "Previous employee", exact: true })
      .click();
    release();
    await expect(p.locator(".org-selected-focus")).toContainText(cycleA.name);
    await expect(p.locator(".org-selected-focus")).not.toContainText(long.name);
    await p.unroute(`**/organization/people/${long.id}`);
    await p.getByRole("button", { name: "Back to me", exact: true }).click();
    await expect(p.locator(".org-selected-focus")).toContainText(viewer.name);
    const target = p
      .locator(".org-selected-focus")
      .getByRole("button", {
        name: `Profile details for ${viewer.name}`,
        exact: true,
      })
      .first();
    await target.tap();
    const pop = p.getByRole("dialog", {
      name: `Profile details for ${viewer.name}`,
      exact: true,
    });
    await expect(pop).toContainText("Bengaluru");
    await p.getByRole("heading", { name: "Organization", exact: true }).click();
    await expect(pop).toHaveCount(0);
    await find(p, "No employee matches this phrase");
    await expect(
      p.getByText("No matching authorized employees found.", { exact: true }),
    ).toBeVisible();
    await p.route("**/organization/people?**", (r) => r.abort());
    await p.getByLabel("Find employees", { exact: true }).fill("Report");
    await expect(
      p.getByRole("button", { name: "Retry employee search", exact: true }),
    ).toBeVisible();
    await expect(
      p.getByText("No matching authorized employees found.", { exact: true }),
    ).toHaveCount(0);
    await p.unroute("**/organization/people?**");
    await p
      .getByRole("button", { name: "Retry employee search", exact: true })
      .click();
    await expect(p.locator(".org-search-results li")).toHaveCount(20);
  } finally {
    await c.close();
  }
});

test("employee communication actions target the right colleague and preserve live calls during hierarchy navigation", async () => {
  test.setTimeout(90000);
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
  const a = await browser.newContext({ permissions: ["camera", "microphone"] }),
    b = await browser.newContext({ permissions: ["camera", "microphone"] });
  let call = "";
  try {
    await login(a);
    await login(b, peer);
    const p = await a.newPage(),
      remote = await b.newPage();
    await open(p);
    await remote.goto(`/?org=${org}`);
    await select(p, peer);
    const selected = p.locator(".org-selected-focus"),
      message = p.waitForResponse(
        (r) =>
          r.url().endsWith("/direct-conversation") &&
          r.request().method() === "POST",
      );
    await selected
      .getByRole("button", { name: `Message ${peer.name}`, exact: true })
      .click();
    const conversation = await message;
    expect(conversation.request().postDataJSON()).toEqual({ userId: peer.id });
    expect(conversation.status()).toBe(200);
    await p.getByRole("button", { name: "Organization", exact: true }).click();
    await expect(selected).toContainText("Finance lead");
    const started = p.waitForResponse(
      (r) =>
        /\/channels\/[^/]+\/calls$/.test(r.url()) &&
        r.request().method() === "POST",
    );
    await selected
      .getByRole("button", { name: `Audio call ${peer.name}`, exact: true })
      .click();
    const response = await started;
    expect(response.request().postDataJSON().mode).toBe("audio");
    call = (await response.json()).id;
    await expect(
      p.getByRole("toolbar", { name: "Call controls" }),
    ).toBeVisible();
    await remote
      .getByRole("button", { name: "Answer with audio", exact: true })
      .click();
    for (const page of [p, remote])
      await expect
        .poll(() =>
          page.locator("audio").evaluateAll(
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
    const before = await (
      await a.request.get(`${api}/organizations/${org}/calls/${call}`)
    ).json();
    await p.getByRole("button", { name: "Organization", exact: true }).click();
    await expect(selected).toContainText("Finance lead");
    await select(p, manager);
    expect(
      (
        await (
          await a.request.get(`${api}/organizations/${org}/calls/${call}`)
        ).json()
      ).participants.map((p: { id: string }) => p.id),
    ).toEqual(before.participants.map((p: { id: string }) => p.id));
    const ended = await a.request.post(
      `${api}/organizations/${org}/calls/${call}/end`,
      {
        headers,
        data: {},
      },
    );
    expect(ended.status()).toBe(200);
    await expect(
      p.getByRole("region", { name: "Active call dock" }),
    ).toHaveCount(0);
    call = "";
    await select(p, peer);
    const video = p.waitForResponse(
      (r) =>
        /\/channels\/[^/]+\/calls$/.test(r.url()) &&
        r.request().method() === "POST",
    );
    await selected
      .getByRole("button", { name: `Video call ${peer.name}`, exact: true })
      .click();
    const vr = await video;
    expect(vr.request().postDataJSON().mode).toBe("video");
    call = (await vr.json()).id;
    await remote
      .getByRole("button", { name: "Answer with video", exact: true })
      .click();
    for (const page of [p, remote])
      await expect
        .poll(() =>
          page
            .locator("video")
            .evaluateAll(
              (nodes) =>
                nodes.filter((v) => (v as HTMLVideoElement).videoWidth > 0)
                  .length,
            ),
        )
        .toBeGreaterThanOrEqual(2);
  } finally {
    if (call)
      await a.request
        .post(`${api}/organizations/${org}/calls/${call}/end`, {
          headers,
          data: {},
        })
        .catch(() => {});
    await browser.close();
  }
});
