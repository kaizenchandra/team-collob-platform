import { test, expect, type Page } from "@playwright/test";
import { completeOtp } from "../helpers/local-otp.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import pg from "pg";

test.skip(
  process.env.TEST_LOCAL_OIDC !== "true" ||
    process.env.TEST_PROVIDER_ADMIN !== "true",
  "Requires explicit local provider fault-injection authorization and temporary admin environment",
);
test.use({ trace: "off", screenshot: "off" });
test.setTimeout(240000);
const api = "http://localhost:4100";
const compose = [
  "compose",
  "-f",
  "compose.yaml",
  "-f",
  "compose.local.yaml",
  "-f",
  "compose.identity.yaml",
];
async function login(page: Page, email: string) {
  await page.goto(`${api}/v1/auth/login`);
  await page.getByLabel(/Username or email/).fill(email);
  await page.getByLabel("Password", { exact: true }).fill("Development123!");
  await page.getByRole("button", { name: "Sign In", exact: true }).click();
  await completeOtp(page, email);
  await expect(page).toHaveURL("http://localhost:3101/");
  await expect(page.getByText("Live", { exact: true })).toBeVisible();
}
const database = () =>
  new pg.Pool({
    connectionString:
      "postgres://concord:local-development-only@localhost:55432/concord",
    max: 2,
  });

test("disabled provider user and missed logout both revoke live sessions within the freshness window", async ({
  browser,
}) => {
  const { request } = await import("../../scripts/local-identity-admin.mjs");
  const [client] = await request(
    "concord-local/clients?clientId=concord-local",
  );
  const alice = "concord-local/users/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const account = await request(alice);
  const contexts = [];
  const db = database();
  try {
    await request(`concord-local/clients/${client.id}`, "PUT", {
      ...client,
      attributes: {
        ...client.attributes,
        "backchannel.logout.url":
          "http://api:4100/v1/auth/deliberately-unavailable",
      },
    });
    const a = await browser.newContext(),
      b = await browser.newContext();
    contexts.push(a, b);
    const page = await a.newPage();
    await login(page, "alice@acme.test");
    await login(await b.newPage(), "bob@acme.test");
    const disabledAt = Date.now();
    await request(alice, "PUT", { ...account, enabled: false });
    await expect
      .poll(async () => (await a.request.get(`${api}/v1/session`)).status(), {
        timeout: 75000,
        intervals: [1000],
      })
      .toBe(401);
    await expect(
      page.getByRole("heading", { name: "A little more connected." }),
    ).toBeVisible();
    expect((await b.request.get(`${api}/v1/session`)).status()).toBe(200);
    const elapsed = Date.now() - disabledAt;
    console.log(
      `Disabled account revoked with undeliverable back-channel callback in ${elapsed}ms (local60s freshness policy).`,
    );
    const audit = await db.query(
      "SELECT count(*)::int AS n FROM audit WHERE actor_id=$1 AND action='identity.session_reconciled' AND created_at>to_timestamp($2/1000.0)",
      ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", disabledAt],
    );
    expect(audit.rows[0].n).toBeGreaterThan(0);
    await request(alice, "PUT", { ...account, enabled: true });
    const c = await browser.newContext();
    contexts.push(c);
    const missed = await c.newPage();
    await login(missed, "alice@acme.test");
    const loggedOutAt = Date.now();
    await request(`${alice}/logout`, "POST");
    await expect
      .poll(async () => (await c.request.get(`${api}/v1/session`)).status(), {
        timeout: 75000,
        intervals: [1000],
      })
      .toBe(401);
    await expect(
      missed.getByRole("heading", { name: "A little more connected." }),
    ).toBeVisible();
    console.log(`Missed logout reconciled in ${Date.now() - loggedOutAt}ms.`);
  } finally {
    await request(alice, "PUT", { ...account, enabled: true });
    await request(`concord-local/clients/${client.id}`, "PUT", client);
    await Promise.all(contexts.map((c) => c.close()));
    await db.end();
  }
});

test("encrypted provider credentials survive API restart and provider outage fails closed without losing the live draft", async ({
  page,
  context,
}) => {
  const db = database();
  let providerStopped = false;
  try {
    await login(page, "alice@acme.test");
    const cookie = (await context.cookies()).find(
      (c) => c.name === "concord_session",
    )!;
    const hash = createHash("sha256").update(cookie.value).digest("hex");
    const row = (
      await db.query(
        "SELECT credential_jwe FROM oidc_sessions WHERE token_hash=$1",
        [hash],
      )
    ).rows[0];
    expect(row.credential_jwe.split(".").length).toBe(5);
    await promisify(execFile)("docker", [...compose, "restart", "api"], {
      timeout: 30000,
    });
    await expect
      .poll(
        async () => {
          try {
            return (await context.request.get(`${api}/ready`)).status();
          } catch {
            return 0;
          }
        },
        { timeout: 20000 },
      )
      .toBe(200);
    await db.query(
      "UPDATE oidc_sessions SET verified_until=now()-interval '1 second' WHERE token_hash=$1",
      [hash],
    );
    await expect
      .poll(
        async () => (await context.request.get(`${api}/v1/session`)).status(),
        { timeout: 15000, intervals: [1000] },
      )
      .toBe(200);
    await page
      .getByRole("textbox", { name: "Message", exact: true })
      .fill("Draft preserved during provider outage");
    await promisify(execFile)("docker", [...compose, "stop", "keycloak"], {
      timeout: 30000,
    });
    providerStopped = true;
    await db.query(
      "UPDATE oidc_sessions SET verified_until=now()-interval '1 second' WHERE token_hash=$1",
      [hash],
    );
    expect((await context.request.get(`${api}/v1/session`)).status()).toBe(503);
    const denied = await context.request.patch(`${api}/v1/profile`, {
      headers: { origin: "http://localhost:3101" },
      data: { name: "Must not mutate" },
    });
    expect(denied.status()).toBe(503);
    await expect(
      page.getByRole("textbox", { name: "Message", exact: true }),
    ).toHaveValue("Draft preserved during provider outage");
    await promisify(execFile)("docker", [...compose, "up", "-d", "keycloak"], {
      timeout: 30000,
    });
    providerStopped = false;
    await expect
      .poll(
        async () => {
          try {
            return (
              await context.request.get(
                "http://localhost:5180/realms/concord-local/.well-known/openid-configuration",
              )
            ).status();
          } catch {
            return 0;
          }
        },
        { timeout: 45000, intervals: [1000] },
      )
      .toBe(200);
    await expect
      .poll(
        async () => (await context.request.get(`${api}/v1/session`)).status(),
        { timeout: 20000, intervals: [1000] },
      )
      .toBe(200);
    await expect(page.getByText("Live", { exact: true })).toBeVisible({
      timeout: 15000,
    });
    await expect(
      page.getByRole("textbox", { name: "Message", exact: true }),
    ).toHaveValue("Draft preserved during provider outage");
  } finally {
    if (providerStopped)
      await promisify(execFile)(
        "docker",
        [...compose, "up", "-d", "keycloak"],
        { timeout: 30000 },
      );
    await db.end();
  }
});
