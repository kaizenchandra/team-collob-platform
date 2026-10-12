// Only this project's loopback development realm. Never accepts a remote target.
if (process.env.DEV_AUTH !== "true" || process.env.NODE_ENV === "production")
  throw new Error("Requires explicit local development mode");
const base = "http://127.0.0.1:5180";
const username = "concord-local-admin";
const password = process.env.CONCORD_TEMP_ADMIN_PASSWORD;
if (!password)
  throw new Error(
    "Set the temporary local admin password through the environment",
  );
let token;
let expiresAt = 0;
async function adminToken() {
  if (token && Date.now() < expiresAt) return token;
  const login = await fetch(
    `${base}/realms/master/protocol/openid-connect/token`,
    {
      method: "POST",
      signal: AbortSignal.timeout(5000),
      body: new URLSearchParams({
        grant_type: "password",
        client_id: "admin-cli",
        username,
        password,
      }),
    },
  );
  if (!login.ok)
    throw new Error(`Local admin authentication failed (${login.status})`);
  const result = await login.json();
  if (
    typeof result.access_token !== "string" ||
    typeof result.expires_in !== "number"
  )
    throw new Error("Invalid local admin response");
  token = result.access_token;
  expiresAt = Date.now() + Math.max(0, result.expires_in - 10) * 1000;
  return token;
}
export async function request(path, method = "GET", body) {
  const response = await fetch(`${base}/admin/realms/${path}`, {
    method,
    signal: AbortSignal.timeout(5000),
    headers: {
      authorization: `Bearer ${await adminToken()}`,
      "content-type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok)
    throw new Error(
      `Local provider administration failed (${response.status})`,
    );
  const content = await response.text();
  return content ? JSON.parse(content) : undefined;
}
