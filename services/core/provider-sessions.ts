import {identityAudit} from "./identity-audit.ts";
import {jwtVerify, type JWTVerifyGetKey} from "jose";
import {z} from "zod";
import {type DB, transaction} from "./db.ts";
import {HttpError} from "./security.ts";

const text = z.string().min(1).max(1024);
const eventName = "http://schemas.openid.net/event/backchannel-logout";
const claimsSchema = z
    .object({
        iss: text,
        iat: z.number().int().nonnegative(),
        jti: text,
        sub: text.optional(),
        sid: text.optional(),
        events: z.record(z.string(), z.unknown()),
    })
    .refine((c) => !!(c.sub || c.sid));
export type LogoutClaims = z.infer<typeof claimsSchema>;

export async function verifyLogout(
    token: string,
    issuer: string,
    client: string,
    keys: JWTVerifyGetKey,
): Promise<LogoutClaims> {
    try {
        const {payload, protectedHeader} = await jwtVerify(token, keys, {
            issuer,
            audience: client,
            algorithms: ["RS256"],
            maxTokenAge: "5m",
            clockTolerance: 5,
            requiredClaims: ["iss", "aud", "iat", "exp", "jti", "events"],
        });
        if (
            protectedHeader.typ &&
            !["jwt", "logout+jwt", "application/logout+jwt"].includes(
                protectedHeader.typ.toLowerCase(),
            )
        )
            throw new Error("Wrong token type");
        const claims = claimsSchema.parse(payload);
        const event = claims.events[eventName];
        if (
            "nonce" in payload ||
            !event ||
            typeof event !== "object" ||
            Array.isArray(event)
        )
            throw new Error("Not a logout event");
        return claims;
    } catch (error) {
        const code = (error as { code?: string }).code;
        if (
            error instanceof TypeError ||
            code === "ERR_JWKS_TIMEOUT" ||
            code === "ERR_JOSE_GENERIC"
        )
            throw new HttpError(503, "Identity keys temporarily unavailable");
        throw new HttpError(400, "Invalid logout token");
    }
}

async function lockIdentity(db: DB, issuer: string, client: string) {
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        JSON.stringify([issuer, client]),
    ]);
}

export async function createProviderSession(
    tokenHash: string,
    userId: string,
    issuer: string,
    client: string,
    subject: string,
    sid: string | undefined,
    issuedAt: number,
    acr?: string,
    credential?: string,
) {
    text.parse(subject);
    if (acr !== undefined) text.parse(acr);
    if (sid !== undefined) text.parse(sid);
    z.number().int().nonnegative().parse(issuedAt);
    await transaction(async (db) => {
        await lockIdentity(db, issuer, client);
        const revoked = await db.query(
            "SELECT 1 FROM oidc_revocations WHERE issuer=$1 AND client_id=$2 AND expires_at>now() AND ((kind='sid' AND value=$3) OR (kind='sub' AND value=$4 AND issued_at >= $5))",
            [issuer, client, sid ?? null, subject, issuedAt],
        );
        if (revoked.rowCount)
            throw new HttpError(401, "Provider session ended. Start a new sign-in.");
        await db.query(
            "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '8 hours')",
            [tokenHash, userId],
        );
        await db.query(
            "INSERT INTO oidc_sessions(token_hash,issuer,client_id,subject,sid,issued_at,acr,credential_jwe,verified_until) VALUES($1,$2,$3,$4,$5,$6,$7,$8,CASE WHEN $8::text IS NOT NULL THEN now()+interval '60 seconds' ELSE NULL END)",
            [
                tokenHash,
                issuer,
                client,
                subject,
                sid ?? null,
                issuedAt,
                acr ?? null,
                credential ?? null,
            ],
        );
        await identityAudit(db, userId, "identity.signed_in", {method: "oidc"});
    });
}

export async function revokeProviderSessions(
    claims: LogoutClaims,
    client: string,
) {
    await transaction(async (db) => {
        await lockIdentity(db, claims.iss, client);
        const receipt = await db.query(
            "INSERT INTO oidc_logout_events(issuer,client_id,jti) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING jti",
            [claims.iss, client, claims.jti],
        );
        if (!receipt.rowCount) return;
        await db.query(
            "INSERT INTO oidc_revocations(issuer,client_id,kind,value,issued_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(issuer,client_id,kind,value) DO UPDATE SET issued_at=GREATEST(oidc_revocations.issued_at,EXCLUDED.issued_at),expires_at=now()+interval '24 hours'",
            [
                claims.iss,
                client,
                claims.sid ? "sid" : "sub",
                claims.sid ?? claims.sub,
                claims.iat,
            ],
        );
        const removed = await db.query(
            "DELETE FROM sessions s USING oidc_sessions p WHERE s.token_hash=p.token_hash AND p.issuer=$1 AND p.client_id=$2 AND ($3::text IS NULL OR p.sid=$3) AND ($4::text IS NULL OR p.subject=$4) AND ($3::text IS NOT NULL OR p.issued_at <= $5) RETURNING s.user_id",
            [claims.iss, client, claims.sid ?? null, claims.sub ?? null, claims.iat],
        );
        for (const userId of new Set<string>(removed.rows.map((row) => row.user_id)))
            await identityAudit(db, userId, "identity.provider_logout", {}, false);
        await db.query(
            "INSERT INTO audit(action,target,metadata) VALUES('identity.provider_logout',$1,$2)",
            [claims.iss, JSON.stringify({revokedSessions: removed.rowCount})],
        );
    });
}
