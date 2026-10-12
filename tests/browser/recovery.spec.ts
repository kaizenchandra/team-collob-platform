import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { completeOtp } from "../helpers/local-otp.ts";

test.skip(
  process.env.TEST_LOCAL_OIDC !== "true",
  "Requires the real local Keycloak recovery flow",
);
test.use({ trace: "off", screenshot: "off" });
test.setTimeout(180000);
const base = "http://localhost:4100";
async function password(page: Page, url = `${base}/v1/auth/login`) {
  await page.goto(url);
  const username = page.getByLabel(/Username or email/);
  if (await username.isVisible()) await username.fill("alice@acme.test");
  await page.getByLabel("Password", { exact: true }).fill("Development123!");
  await page.getByRole("button", { name: "Sign In", exact: true }).click();
}
async function enroll(page: Page) {
  await expect(page.locator("#kc-recovery-codes-list")).toBeVisible();
  const codes = (
    await page.locator("#kc-recovery-codes-list li").allTextContents()
  ).map((s) => s.replace(/^\s*\d+:\s*/, "").replace(/[\s-]/g, ""));
  if (codes.length !== 12 || codes.some((c) => !/^[A-Za-z0-9]{12}$/.test(c)))
    throw new Error("Unexpected provider recovery-code format");
  await expect(page.locator("#saveRecoveryAuthnCodesBtn")).toBeDisabled();
  await page.locator("#kcRecoveryCodesConfirmationCheck").check();
  await page.locator("#saveRecoveryAuthnCodesBtn").click();
  await expect(page).toHaveURL("http://localhost:3101/");
  return codes;
}
async function chooseRecovery(page: Page) {
  await page.getByRole("link", { name: /Try Another Way/i }).click();
  await page.getByText("Recovery Authentication Code", { exact: true }).click();
  await expect(page.locator("#recoveryCodeInput")).toBeVisible();
}
async function submit(page: Page, code: string) {
  await page.locator("#recoveryCodeInput").fill(code);
  await page.locator("#kc-login").click();
}
async function denied(page: Page, context: BrowserContext) {
  await expect(
    page.getByText("Invalid recovery authentication code", { exact: true }),
  ).toBeVisible();
  expect((await context.request.get(`${base}/v1/session`)).status()).toBe(401);
}

test("provider recovery enrollment, one-time use and replacement retain MFA without exposing codes to the application", async ({
  browser,
}) => {
  const contexts: BrowserContext[] = [];
  const applicationRequests: string[] = [];
  async function fresh() {
    const context = await browser.newContext();
    contexts.push(context);
    context.on("request", (request) => {
      if (new URL(request.url()).origin === base)
        applicationRequests.push(request.url() + (request.postData() ?? ""));
    });
    return { context, page: await context.newPage() };
  }
  try {
    const initial = await fresh();
    await password(initial.page);
    await completeOtp(initial.page, "alice@acme.test");
    await expect(initial.page).toHaveURL("http://localhost:3101/");
    await initial.page
      .getByRole("button", { name: "Settings", exact: true })
      .click();
    const manage = initial.page.getByRole("link", {
      name: "Manage recovery codes",
    });
    await expect(manage).toBeVisible();
    await manage.click();
    await initial.page.getByLabel(/Username or email/).fill("alice@acme.test");
    await initial.page
      .getByLabel("Password", { exact: true })
      .fill("Development123!");
    await initial.page
      .getByRole("button", { name: "Sign In", exact: true })
      .click();
    await completeOtp(initial.page, "alice@acme.test");
    const original = await enroll(initial.page);
    await initial.context.close();

    const recovered = await fresh();
    await password(recovered.page);
    await chooseRecovery(recovered.page);
    await submit(recovered.page, "invalid");
    await denied(recovered.page, recovered.context);
    await submit(recovered.page, original[0]);
    await expect(recovered.page).toHaveURL("http://localhost:3101/");
    expect(
      (await recovered.context.request.get(`${base}/v1/session`)).status(),
    ).toBe(200);
    await recovered.context.close();

    const replay = await fresh();
    await password(replay.page);
    await chooseRecovery(replay.page);
    await submit(replay.page, original[0]);
    await denied(replay.page, replay.context);
    await submit(replay.page, original[1]);
    await expect(replay.page).toHaveURL("http://localhost:3101/");
    await replay.context.close();

    const replacement = await fresh();
    await password(
      replacement.page,
      `${base}/v1/auth/login?action=recovery-codes`,
    );
    await completeOtp(replacement.page, "alice@acme.test");
    const renewed = await enroll(replacement.page);
    await replacement.context.close();

    const cancelled = await fresh();
    await password(cancelled.page, `${base}/v1/auth/login?action=recovery-codes`);
    await completeOtp(cancelled.page, "alice@acme.test");
    await expect(cancelled.page.locator("#kc-recovery-codes-list")).toBeVisible();
    await cancelled.page.locator("#cancelRecoveryAuthnCodesBtn").click();
    await expect(cancelled.page).toHaveURL("http://localhost:3101/");
    await cancelled.context.close();

    const obsolete = await fresh();
    await password(obsolete.page);
    await chooseRecovery(obsolete.page);
    await submit(obsolete.page, original[2]);
    await denied(obsolete.page, obsolete.context);
    await submit(obsolete.page, renewed[0]);
    await expect(obsolete.page).toHaveURL("http://localhost:3101/");
    expect(
      (await obsolete.context.request.get(`${base}/v1/session`)).status(),
    ).toBe(200);
    for (const code of [...original, ...renewed]) {
      if (applicationRequests.some((request) => request.includes(code)))
        throw new Error("A recovery code reached the application endpoint");
    }
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
  }
});
