import { pool } from "./db.ts";
import type { User } from "./server.ts";
export function sessionReader(
  env: Partial<NodeJS.ProcessEnv> = process.env,
  reconcile?: (tokenHash: string) => Promise<void>,
) {
  const issuer = env.OIDC_ISSUER ?? null;
  const client = env.OIDC_CLIENT_ID ?? null;
  const acr = env.OIDC_REQUIRED_ACR || null;
  const development = env.DEV_AUTH === "true" && env.NODE_ENV !== "production";
  const read = (tokenHash: string) =>
    pool.query<User>(
      `SELECT u.id,u.email,u.name,u.title,u.timezone,u.status,u.preferences
     FROM sessions s JOIN users u ON u.id=s.user_id
     LEFT JOIN oidc_sessions p ON p.token_hash=s.token_hash
     WHERE s.token_hash=$1 AND s.expires_at>now() AND NOT u.disabled
       AND ((p.token_hash IS NULL AND $2::boolean)
         OR (p.issuer=$3 AND p.client_id=$4 AND ($5::text IS NULL OR p.acr=$5)))`,
      [tokenHash, development, issuer, client, acr],
    );
  return async (tokenHash: string) => {
    const initial = await read(tokenHash);
    if (!initial.rowCount || !reconcile) return initial;
    await reconcile(tokenHash);
    return read(tokenHash);
  };
}
