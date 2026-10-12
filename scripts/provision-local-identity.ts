import { pool, migrate, transaction } from "../services/core/db.ts";
if (process.env.NODE_ENV === "production" || process.env.DEV_AUTH !== "true")
  throw new Error(
    "Local identity provisioning requires DEV_AUTH=true and non-production",
  );
try {
  await migrate();
  await transaction(async (db) => {
    for (const [id, email] of [
      ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "alice@acme.test"],
      ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "bob@acme.test"],
    ]) {
      const subject = `http://localhost:5180/realms/concord-local|${id}`;
      const result = await db.query(
        "UPDATE users SET oidc_subject=$3 WHERE id=$1 AND email=$2 AND (oidc_subject IS NULL OR oidc_subject=$3)",
        [id, email, subject],
      );
      if (result.rowCount !== 1)
        throw new Error(
          "Expected synthetic seed identity is missing or already bound to another provider",
        );
    }
  });
  console.log(
    "Bound two synthetic identities to the local realm; no memberships granted.",
  );
} finally {
  await pool.end();
}
