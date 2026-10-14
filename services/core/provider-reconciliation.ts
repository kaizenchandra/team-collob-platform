import {identityAudit} from "./identity-audit.ts";
import {randomInt, randomUUID} from "node:crypto";
import {pool, transaction} from "./db.ts";
import {HttpError} from "./security.ts";
import {credentialBinding, type TokenVault} from "./token-vault.ts";

export type ProviderBinding = {
    token_hash: string;
    issuer: string;
    client_id: string;
    subject: string;
    credential_jwe: string | null;
};
export type CheckProvider = (
    token: string,
    binding: ProviderBinding,
) => Promise<{ active: false } | { active: true; refreshToken: string }>;
export const freshnessSeconds = 60;

export function providerReconciler(
    issuer: string,
    client: string,
    vault: TokenVault,
    check: CheckProvider,
) {
    const running = new Map<string, Promise<void>>();

    async function perform(tokenHash: string) {
        const row = (
            await pool.query<ProviderBinding & { fresh: boolean }>(
                `SELECT p.*,p.verified_until>now() AS fresh FROM oidc_sessions p JOIN sessions s USING(token_hash) WHERE p.token_hash=$1 AND p.issuer=$2 AND p.client_id=$3 AND s.expires_at>now()`,
                [tokenHash, issuer, client],
            )
        ).rows[0];
        if (!row) return;
        if (!row.credential_jwe)
            throw new HttpError(401, "Sign in again to verify your provider session");
        if (row.fresh) return;
        const lease = randomUUID();
        const claimed = await pool.query(
            `UPDATE oidc_sessions SET check_lease_id=$2,check_lease_until=now()+interval '20 seconds' WHERE token_hash=$1 AND (verified_until IS NULL OR verified_until<=now()) AND (check_lease_until IS NULL OR check_lease_until<=now()) RETURNING token_hash`,
            [tokenHash, lease],
        );
        if (!claimed.rowCount)
            throw new HttpError(503, "Identity verification is busy. Retry shortly.");
        try {
            const binding = credentialBinding(tokenHash, issuer, client, row.subject);
            const token = await vault.open(row.credential_jwe, binding);
            const result = await check(token, row);
            if (!result.active) {
                await transaction(async (db) => {
                    const removed = await db.query(
                        `DELETE FROM sessions s USING oidc_sessions p WHERE s.token_hash=p.token_hash AND p.token_hash=$1 AND p.check_lease_id=$2 AND p.check_lease_until>now() RETURNING s.user_id`,
                        [tokenHash, lease],
                    );
                    if (!removed.rowCount)
                        throw new HttpError(
                            503,
                            "Session verification changed. Retry shortly.",
                        );
                    await identityAudit(db, removed.rows[0].user_id, "identity.session_reconciled", {reason: "provider_inactive"});
                });
                throw new HttpError(401, "Your provider session ended. Sign in again.");
            }
            const encrypted = await vault.seal(result.refreshToken, binding);
            const updated = await pool.query(
                `UPDATE oidc_sessions SET credential_jwe=$3,verified_until=now()+($4 * interval '1 second'),check_lease_id=NULL,check_lease_until=NULL WHERE token_hash=$1 AND check_lease_id=$2 AND check_lease_until>now() RETURNING token_hash`,
                [tokenHash, lease, encrypted, freshnessSeconds],
            );
            if (!updated.rowCount)
                throw new HttpError(
                    503,
                    "Session verification changed. Retry shortly.",
                );
        } catch (error) {
            if (error instanceof HttpError && error.statusCode === 401) throw error;
            await pool.query(
                `UPDATE oidc_sessions SET check_lease_until=now()+($3 * interval '1 millisecond') WHERE token_hash=$1 AND check_lease_id=$2`,
                [tokenHash, lease, randomInt(2000, 5001)],
            );
            // Never surface provider error bodies, JWTs or key material.
            throw new HttpError(
                503,
                "Identity verification is temporarily unavailable. Retry shortly.",
            );
        }
    }

    return async (tokenHash: string) => {
        const existing = running.get(tokenHash);
        if (existing) return existing;
        if (running.size >= 32)
            throw new HttpError(503, "Identity verification is busy. Retry shortly.");
        const promise = perform(tokenHash).finally(() => running.delete(tokenHash));
        running.set(tokenHash, promise);
        return promise;
    };
}
