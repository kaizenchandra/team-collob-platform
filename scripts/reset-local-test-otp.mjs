// Explicit test maintenance only; not an end-user recovery mechanism.
import { request } from "./local-identity-admin.mjs";
const email = process.argv[2];
if (
  !["alice@acme.test", "bob@acme.test", "unprovisioned@acme.test"].includes(
    email,
  )
)
  throw new Error("Only fixed synthetic local identities may be reset");
const users = await request(
  `concord-local/users?username=${encodeURIComponent(email)}&exact=true`,
);
if (users.length !== 1) throw new Error("Expected one synthetic user");
const path = `concord-local/users/${users[0].id}`;
await request(`${path}/logout`, "POST");
const credentials = await request(`${path}/credentials`);
for (const credential of credentials.filter((c) => c.type === "otp"))
  await request(`${path}/credentials/${credential.id}`, "DELETE");
console.log(
  "Reset synthetic local OTP and provider sessions; next sign-in requires enrollment.",
);
