import { test, expect, type Page } from "@playwright/test";

import { completeOtp } from "../helpers/local-otp.ts";
// Enrollment screens contain secrets; never retain identity traces or screenshots.
test.use({ trace: "off", screenshot: "off" });
test.setTimeout(90000);

test.skip(
  process.env.TEST_LOCAL_OIDC !== "true",
  "Requires the explicit local Keycloak overlay and subject provisioning",
);
async function providerLogin(
  page: Page,
  email: string,
  mfa = true,
  rejectInvalid = false,
) {
  await expect(page).toHaveURL(/localhost:5180/);
  await page.getByLabel(/Username or email/).fill(email);
  await page.getByLabel("Password", { exact: true }).fill("Development123!");
  await page.getByRole("button", { name: "Sign In", exact: true }).click();
  if (mfa) await completeOtp(page, email, rejectInvalid);
}

test("live OIDC PKCE login establishes the provisioned identity and local logout revokes its session", async ({
  page,
  context,
}) => {
  await page.goto("http://localhost:4100/v1/auth/login");
  const authUrl = new URL(page.url());
  expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
  const state = authUrl.searchParams.get("state")!;
  await providerLogin(page, "alice@acme.test", true, true);
  await expect(page).toHaveURL("http://localhost:3101/");
  await expect(page.getByRole("combobox", { name: "WORKSPACE" })).toHaveValue(
    "11111111-1111-4111-8111-111111111111",
  );
  await page.getByRole("button", {name: "Admin", exact: true}).click();
  await expect(page.getByRole("heading", {name: "Audit history", exact: true})).toBeVisible();
  await expect(page.getByText("identity.signed_in", {exact: true}).first()).toBeVisible();
  const audit = await context.request.get("http://localhost:4100/v1/organizations/11111111-1111-4111-8111-111111111111/audit");
  expect(audit.ok()).toBeTruthy();
  const events = (await audit.json()).items;
  expect(events.some((event: {action: string; actor_id: string; metadata: {method?: string}}) => event.action === "identity.signed_in" && event.actor_id === "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" && event.metadata.method === "oidc")).toBeTruthy();
  expect(events.every((event: {org_id: string}) => event.org_id === "11111111-1111-4111-8111-111111111111")).toBeTruthy();
  const session = await context.request.get("http://localhost:4100/v1/session");
  expect(session.ok()).toBeTruthy();
  expect((await session.json()).user.email).toBe("alice@acme.test");
  expect(
    (await context.cookies()).some((c) => c.name === "concord_oidc"),
  ).toBeFalsy();
  const replay = await context.request.get(
    `http://localhost:4100/v1/auth/callback?state=${state}&code=already-used`,
  );
  expect(replay.status()).toBe(400);
  const { default: pg } = await import("pg");
  const db = new pg.Pool({connectionString: "postgres://concord:local-development-only@localhost:55432/concord", max: 1});
  try {
    const correlation = (await replay.json()).correlationId;
    const failed = (await db.query("SELECT * FROM audit WHERE action='identity.authentication_failed' AND metadata->>'correlationId'=$1", [correlation])).rows;
    expect(failed).toHaveLength(1);
    expect(failed[0].actor_id).toBeNull();
    expect(failed[0].org_id).toBeNull();
    expect(failed[0].metadata).toEqual({route: "oidc_callback", status: 400, correlationId: correlation});
    expect(JSON.stringify(failed)).not.toContain(state);
    expect(JSON.stringify(failed)).not.toContain("already-used");
  } finally { await db.end(); }
  const logout = await context.request.delete(
    "http://localhost:4100/v1/session",
    { headers: { origin: "http://localhost:3100" } },
  );
  expect(logout.ok()).toBeTruthy();
  expect(
    (await context.request.get("http://localhost:4100/v1/session")).status(),
  ).toBe(401);
});

test("a valid provider identity without a provisioned subject gets no application session", async ({
  page,
  context,
}) => {
  await page.goto("http://localhost:4100/v1/auth/login");
  await providerLogin(page, "unprovisioned@acme.test");
  await expect(page).toHaveURL(/localhost:4100\/v1\/auth\/callback/);
  await expect(page.locator("body")).toContainText("has not been provisioned");
  expect(
    (await context.request.get("http://localhost:4100/v1/session")).status(),
  ).toBe(401);
});

test("live password-only identity cannot satisfy a stronger configured assurance requirement", async ({
  page,
  context,
}) => {
  // A second API instance uses the same persistent flow store and real provider.
  // The browser routes only the callback to that instance; token exchange is live.
  const keys = [
    "OIDC_ISSUER",
    "OIDC_CLIENT_ID",
    "OIDC_CLIENT_SECRET",
    "OIDC_REDIRECT_URI",
    "OIDC_LOCAL_HTTP",
    "OIDC_INTERNAL_ORIGIN",
    "OIDC_REQUIRED_ACR",
    "LOG_LEVEL",
  ];
  const previous = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, {
    OIDC_ISSUER: "http://localhost:5180/realms/concord-local",
    OIDC_CLIENT_ID: "concord-assurance-test",
    OIDC_CLIENT_SECRET: "local-assurance-test-only",
    OIDC_REDIRECT_URI: "http://localhost:4100/v1/auth/callback",
    OIDC_LOCAL_HTTP: "true",
    OIDC_REQUIRED_ACR: "urn:concord:mfa",
    LOG_LEVEL: "silent",
  });
  delete process.env.OIDC_INTERNAL_ORIGIN;
  const { createApp } = await import("../../services/core/server.ts");
  const { pool } = await import("../../services/core/db.ts");
  const app = await createApp();
  try {
    const response = await app.inject({ url: "/v1/auth/login" });
    expect(response.statusCode).toBe(302);
    const cookie = String(response.headers["set-cookie"]).split(";")[0];
    await context.addCookies([
      {
        name: "concord_oidc",
        value: cookie.slice(cookie.indexOf("=") + 1),
        domain: "localhost",
        path: "/v1/auth",
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    const before = await pool.query("SELECT count(*)::int AS n FROM sessions");
    await page.route(
      /localhost:5180\/realms\/concord-local\/login-actions\/authenticate/,
      async (route) => {
        const providerResponse = await route.fetch({ maxRedirects: 0 });
        const location = providerResponse.headers().location;
        expect(location).toContain("http://localhost:4100/v1/auth/callback");
        const url = new URL(location);
        const result = await app.inject({
          url: url.pathname + url.search,
          headers: { cookie },
        });
        await route.fulfill({
          status: result.statusCode,
          contentType: "application/json",
          body: result.body,
        });
      },
    );
    const authorization = new URL(String(response.headers.location));
    expect(authorization.searchParams.get("acr_values")).toBe(
      "urn:concord:mfa",
    );
    // A browser can tamper with these hints. The API must still enforce its policy
    // against the signed ID token obtained from the actual provider.
    authorization.searchParams.delete("claims");
    authorization.searchParams.delete("acr_values");
    await page.goto(authorization.href);
    await providerLogin(page, "alice@acme.test", false);
    await expect(page.locator("body")).toContainText(
      "Required sign-in assurance was not satisfied",
    );
    expect(
      (await pool.query("SELECT count(*)::int AS n FROM sessions")).rows[0].n,
    ).toBe(before.rows[0].n);
    expect(
      (await context.request.get("http://localhost:4100/v1/session")).status(),
    ).toBe(401);
  } finally {
    await app.close();
    await pool.end();
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

test("an in-flight provider login survives a real API container restart", async ({
  page,
  context,
}) => {
  test.setTimeout(90000);
  await page.goto("http://localhost:4100/v1/auth/login");
  await expect(page.getByLabel(/Username or email/)).toBeVisible();
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  await promisify(execFile)(
    "docker",
    [
      "compose",
      "-f",
      "compose.yaml",
      "-f",
      "compose.local.yaml",
      "-f",
      "compose.identity.yaml",
      "restart",
      "api",
    ],
    { timeout: 30000 },
  );
  await expect
    .poll(
      async () => {
        try {
          return (
            await context.request.get("http://localhost:4100/ready")
          ).status();
        } catch {
          return 0;
        }
      },
      { timeout: 15000 },
    )
    .toBe(200);
  await providerLogin(page, "bob@acme.test");
  await expect(page).toHaveURL("http://localhost:3101/");
  const session = await context.request.get("http://localhost:4100/v1/session");
  expect(session.ok()).toBeTruthy();
  expect((await session.json()).user.email).toBe("bob@acme.test");
});

test("real provider logout revokes the application session and active UI while another identity stays signed in", async ({
  page,
  context,
  browser,
}) => {
  await page.goto("http://localhost:4100/v1/auth/login");
  await providerLogin(page, "alice@acme.test");
  await expect(page).toHaveURL("http://localhost:3101/");
  await expect(page.getByText("Live", { exact: true })).toBeVisible();
  const peer = await browser.newContext();
  try {
    const bob = await peer.newPage();
    await bob.goto("http://localhost:4100/v1/auth/login");
    await providerLogin(bob, "bob@acme.test");
    await expect(bob).toHaveURL("http://localhost:3101/");
    const invalid = await context.request.post(
      "http://localhost:4100/v1/auth/backchannel-logout",
      {
        form: {
          logout_token: "not-a-signed-token",
          ignored_extension: "ignored",
        },
      },
    );
    expect(invalid.status()).toBe(400);
    expect(
      (await context.request.get("http://localhost:4100/v1/session")).status(),
    ).toBe(200);
    await page.route("**/v1/channels/*/messages", async (route) => {
      if (route.request().method() === "POST") await route.abort();
      else await route.continue();
    });
    await page
      .getByRole("textbox", { name: "Message", exact: true })
      .fill("Pending before provider logout");
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Retry safely" }),
    ).toBeVisible();
    const provider = await context.newPage();
    await provider.goto(
      "http://localhost:5180/realms/concord-local/protocol/openid-connect/logout?client_id=concord-local",
    );
    await provider.getByRole("button", { name: /^log ?out$/i }).click();
    await expect
      .poll(
        async () =>
          (
            await context.request.get("http://localhost:4100/v1/session")
          ).status(),
        { timeout: 10000 },
      )
      .toBe(401);
    await expect(
      page.getByRole("heading", { name: "A little more connected." }),
    ).toBeVisible();
    expect(
      await page.evaluate(() =>
        sessionStorage.getItem("concord.pending-messages.v1"),
      ),
    ).toBeNull();
    expect(
      (await peer.request.get("http://localhost:4100/v1/session")).status(),
    ).toBe(200);
  } finally {
    await peer.close();
  }
});

test("removing browser assurance hints cannot bypass the application client OTP minimum", async ({
  page,
  context,
}) => {
  await page.goto("http://localhost:4100/v1/auth/login");
  const url = new URL(page.url());
  url.searchParams.delete("claims");
  url.searchParams.delete("acr_values");
  await page.goto(url.href);
  await page.getByLabel(/Username or email/).fill("alice@acme.test");
  await page.getByLabel("Password", { exact: true }).fill("Development123!");
  await page.getByRole("button", { name: "Sign In", exact: true }).click();
  await expect(page.locator("#otp")).toBeVisible();
  expect(
    (await context.request.get("http://localhost:4100/v1/session")).status(),
  ).toBe(401);
  await completeOtp(page, "alice@acme.test");
  await expect(page).toHaveURL("http://localhost:3101/");
  expect(
    (await context.request.get("http://localhost:4100/v1/session")).status(),
  ).toBe(200);
});
