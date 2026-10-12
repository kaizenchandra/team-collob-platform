import { expect, type Page } from "@playwright/test";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { TOTP } from "otpauth";
const path = ".data/local-test-otp.json";
// Only synthetic loopback identities. Never used by the application or CI production.
export async function completeOtp(
  page: Page,
  email: string,
  rejectInvalid = false,
) {
  if (
    process.env.TEST_LOCAL_OIDC !== "true" ||
    process.env.NODE_ENV === "production" ||
    !["alice@acme.test", "bob@acme.test", "unprovisioned@acme.test"].includes(
      email,
    )
  )
    throw new Error("Local OTP helper denied");
  await expect(page.locator("#totp, #otp")).toBeVisible();
  if (new URL(page.url()).origin !== "http://localhost:5180")
    throw new Error("Unexpected OTP provider");
  let secrets: Record<string, string> = {};
  try {
    secrets = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const enrollment = (await page.locator("#totp").count()) > 0;
  if (enrollment) {
    expect(
      (
        await page.context().request.get("http://localhost:4100/v1/session")
      ).status(),
    ).toBe(401);
    await page.locator("#mode-manual").click();
    const secret = (
      await page.locator("#kc-totp-secret-key").innerText()
    ).replace(/\s/g, "");
    if (!/^[A-Z2-7]+$/.test(secret))
      throw new Error("Unexpected enrollment secret format");
    secrets[email] = secret;
    await mkdir(".data", { recursive: true, mode: 0o700 });
    await writeFile(path, JSON.stringify(secrets), {
      encoding: "utf8",
      mode: 0o600,
    });
    await chmod(path, 0o600);
    await page.locator("#userLabel").fill("Concord local automated test");
  }
  const secret = secrets[email];
  if (!secret)
    throw new Error(
      "Local OTP test state missing. Use the documented explicit provider credential reset; do not weaken MFA.",
    );
  const code = page.locator(enrollment ? "#totp" : "#otp");
  const submit = page.locator(enrollment ? "#saveTOTPBtn" : "#kc-login");
  if (rejectInvalid) {
    await code.fill("invalid");
    await submit.click();
    await expect(
      page.getByText("Invalid authenticator code.", { exact: true }),
    ).toBeVisible();
    expect(
      (
        await page.context().request.get("http://localhost:4100/v1/session")
      ).status(),
    ).toBe(401);
  }
  // The provider rejects reuse in the same 30-second time step. Wait rather
  // than weakening its policy or minting future tokens. Persist across test runs.
  const usedPath = ".data/local-test-otp-used.json";
  let used: Record<string, number> = {};
  try {
    used = JSON.parse(await readFile(usedPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (used[email] === Math.floor(Date.now() / 30000))
    await new Promise((resolve) =>
      setTimeout(resolve, 30000 - (Date.now() % 30000) + 500),
    );
  const otp = new TOTP({ secret, algorithm: "SHA1", digits: 6, period: 30 });
  used[email] = Math.floor(Date.now() / 30000);
  await writeFile(usedPath, JSON.stringify(used), { mode: 0o600 });
  await code.fill(otp.generate());
  await submit.click();
  if (enrollment)
    console.log(
      "Completed real provider OTP enrollment for a synthetic local identity.",
    );
}
