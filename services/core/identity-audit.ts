import type {DB} from "./db.ts";

export type IdentityEvent =
    | "identity.signed_in"
    | "identity.signed_out"
    | "identity.session_reconciled"
    | "identity.provider_logout";

// Only call with a server-verified user. Never accept an organization from a request.
export async function identityAudit(
    db: DB,
    userId: string,
    action: IdentityEvent,
    metadata: { method?: "oidc" | "development"; reason?: "provider_inactive" } = {},
    global = true,
) {
    if (global)
        await db.query(
            "INSERT INTO audit(actor_id,action,target,metadata) VALUES($1,$2,$3,$4)",
            [userId, action, userId, JSON.stringify(metadata)],
        );
    await db.query(
        `INSERT INTO audit(org_id,actor_id,action,target,metadata)
     SELECT org_id,user_id,$2,user_id::text,$3 FROM memberships WHERE user_id=$1 AND active`,
        [userId, action, JSON.stringify(metadata)],
    );
}

export function authenticationRoute(method: string, route: string | undefined) {
    if (method === "POST" && route === "/v1/session") return "development_sign_in";
    if (method === "GET" && route === "/v1/auth/login") return "oidc_start";
    if (method === "GET" && route === "/v1/auth/callback") return "oidc_callback";
    if (method === "POST" && route === "/v1/auth/backchannel-logout") return "provider_logout";
}

export async function authenticationFailure(
    db: DB,
    route: NonNullable<ReturnType<typeof authenticationRoute>>,
    status: number,
    correlationId: string,
) {
    await db.query(
        `INSERT INTO audit(action,target,metadata) VALUES('identity.authentication_failed','authentication',$1)`,
        [JSON.stringify({route, status, correlationId: correlationId.slice(0, 128)})],
    );
}
