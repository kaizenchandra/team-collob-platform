import { timingSafeEqual } from "node:crypto";
import { pool, transaction } from "./db.ts";
import { hash, HttpError } from "./security.ts";

export async function saveLogin(
  state: string,
  verifier: string,
  nonce: string,
  binding: string,
) {
  await transaction(async (db) => {
    // Bound outstanding secrets across replicas, not just per process.
    await db.query("SELECT pg_advisory_xact_lock(712341)");
    await db.query("DELETE FROM oidc_transactions WHERE expires_at <= now()");
    const count = await db.query(
      "SELECT count(*)::int AS n FROM oidc_transactions",
    );
    if (count.rows[0].n >= 1000)
      throw new HttpError(429, "Sign-in temporarily busy. Retry shortly.");
    await db.query(
      "INSERT INTO oidc_transactions(state_hash,verifier,nonce,binding) VALUES($1,$2,$3,$4)",
      [hash(state), verifier, nonce, binding],
    );
  });
}

export async function consumeLogin(
  state: string,
  cookie: string | undefined,
  binding: string,
) {
  // A request without the initiating browser's cookie must not burn a valid flow.
  if (
    !state ||
    !cookie ||
    state.length > 256 ||
    cookie.length > 256 ||
    !timingSafeEqual(Buffer.from(hash(state)), Buffer.from(hash(cookie)))
  )
    throw new HttpError(400, "Sign-in expired or state mismatch");
  const result = await pool.query<{ verifier: string; nonce: string }>(
    "DELETE FROM oidc_transactions WHERE state_hash=$1 AND binding=$2 AND expires_at>now() RETURNING verifier,nonce",
    [hash(state), binding],
  );
  if (!result.rowCount)
    throw new HttpError(400, "Sign-in expired or state mismatch");
  return result.rows[0];
}
