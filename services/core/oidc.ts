import {credentialBinding, loadTokenVault} from "./token-vault.ts";
import {providerReconciler} from "./provider-reconciliation.ts";
import {identityAction} from "./identity-actions.ts";
import type {FastifyInstance} from "fastify";
import * as oidc from "openid-client";
import {createRemoteJWKSet, customFetch} from "jose";
import {createProviderSession, revokeProviderSessions, verifyLogout,} from "./provider-sessions.ts";
import {randomBytes} from "node:crypto";
import {pool} from "./db.ts";
import {hash, HttpError} from "./security.ts";
import {consumeLogin, saveLogin} from "./oidc-state.ts";

// Provider provisioning is deliberately separate from identity: unknown identities have no memberships.
export async function registerOidc(app: FastifyInstance, webOrigin: string) {
    const issuer = process.env.OIDC_ISSUER,
        client = process.env.OIDC_CLIENT_ID;
    const localHttp = process.env.OIDC_LOCAL_HTTP === "true";
    if (localHttp && process.env.NODE_ENV === "production")
        throw new Error("Local HTTP identity transport forbidden in production");
    const internalOrigin = process.env.OIDC_INTERNAL_ORIGIN;
    if (internalOrigin && !localHttp)
        throw new Error(
            "Identity origin routing is only available in local HTTP mode",
        );
    const requiredAcr = process.env.OIDC_REQUIRED_ACR;
    const reconcileEnabled = process.env.OIDC_RECONCILE === "true";
    if (
        reconcileEnabled &&
        (!issuer || !client || !process.env.OIDC_TOKEN_KEY_FILE)
    )
        throw new Error(
            "Provider reconciliation and token key file must be configured",
        );
    const vault = reconcileEnabled
        ? await loadTokenVault(
            process.env.OIDC_TOKEN_KEY_FILE!,
            localHttp &&
            process.env.DEV_AUTH === "true" &&
            process.env.NODE_ENV !== "production",
        )
        : undefined;

    let config: oidc.Configuration | undefined;
    let logoutKeys: ReturnType<typeof createRemoteJWKSet> | undefined;

    async function configured() {
        if (!issuer || !client)
            throw new HttpError(503, "Enterprise sign-in is not configured");
        config ??= await oidc.discovery(
            new URL(issuer),
            client,
            process.env.OIDC_CLIENT_SECRET,
            undefined,
            {
                timeout: 5,
                ...(localHttp ? {execute: [oidc.allowInsecureRequests]} : {}),
                ...(internalOrigin
                    ? {
                        [oidc.customFetch]: (
                            input: string,
                            init: oidc.CustomFetchOptions,
                        ) => {
                            const url = new URL(input);
                            if (url.origin !== new URL(issuer).origin)
                                throw new Error("Unexpected identity endpoint origin");
                            const target = new URL(internalOrigin);
                            url.host = target.host;
                            url.protocol = target.protocol;
                            return fetch(url, {
                                ...init,
                                body:
                                    init.body instanceof Uint8Array
                                        ? new Blob([Uint8Array.from(init.body)])
                                        : init.body,
                            });
                        },
                    }
                    : {}),
            },
        );
        return config;
    }

    const reconcile = vault
        ? providerReconciler(
            issuer!,
            client!,
            vault,
            async (refreshToken, binding) => {
                const c = await configured();
                const info = await oidc.tokenIntrospection(c, refreshToken, {
                    token_type_hint: "refresh_token",
                });
                if (!info.active) return {active: false};
                if (
                    info.sub !== binding.subject ||
                    info.client_id !== client ||
                    (info.iss !== undefined && info.iss !== issuer)
                )
                    throw new Error("Invalid provider introspection binding");
                try {
                    const renewed = await oidc.refreshTokenGrant(c, refreshToken);
                    if (renewed.claims() && renewed.claims()!.sub !== binding.subject)
                        throw new Error("Invalid refreshed subject");
                    return {
                        active: true,
                        refreshToken: renewed.refresh_token ?? refreshToken,
                    };
                } catch (error) {
                    if (
                        error instanceof oidc.ResponseBodyError &&
                        error.error === "invalid_grant"
                    )
                        return {active: false};
                    throw error;
                }
            },
        )
        : undefined;
    const redirect =
        process.env.OIDC_REDIRECT_URI ?? "http://localhost:4100/v1/auth/callback";
    const binding = JSON.stringify([issuer, client, redirect, requiredAcr ?? ""]);
    const cleanup = setInterval(() => {
        void Promise.all([
            pool.query("DELETE FROM oidc_transactions WHERE expires_at <= now()"),
            pool.query("DELETE FROM oidc_logout_events WHERE expires_at <= now()"),
            pool.query("DELETE FROM oidc_revocations WHERE expires_at <= now()"),
        ]).catch(() => app.log.warn("Expired identity transaction cleanup failed"));
    }, 60000);
    cleanup.unref();
    app.addHook("onClose", async () => {
        clearInterval(cleanup);
    });
    app.addContentTypeParser(
        "application/x-www-form-urlencoded",
        {parseAs: "string"},
        (_req, body, done) => {
            const params = new URLSearchParams(String(body));
            if (params.getAll("logout_token").length !== 1)
                return done(new HttpError(400, "Expected one logout token"));
            done(null, {logout_token: params.get("logout_token")});
        },
    );
    app.post(
        "/v1/auth/backchannel-logout",
        {bodyLimit: 16384},
        async (req, reply) => {
            const body = req.body as { logout_token?: unknown } | undefined;
            if (
                !req.headers["content-type"]?.startsWith(
                    "application/x-www-form-urlencoded",
                ) ||
                typeof body?.logout_token !== "string"
            )
                throw new HttpError(400, "Expected form-encoded logout token");
            const c = await configured();
            if (!logoutKeys) {
                const jwks = new URL(c.serverMetadata().jwks_uri!);
                if (jwks.protocol !== "https:" && !localHttp)
                    throw new HttpError(503, "Secure identity keys required");
                logoutKeys = createRemoteJWKSet(jwks, {
                    timeoutDuration: 5000,
                    ...(internalOrigin
                        ? {
                            [customFetch]: async (
                                input: string | URL | Request,
                                init?: RequestInit,
                            ) => {
                                const url = new URL(
                                    typeof input === "string"
                                        ? input
                                        : input instanceof URL
                                            ? input.href
                                            : input.url,
                                );
                                if (url.origin !== new URL(issuer!).origin)
                                    throw new Error("Unexpected identity key origin");
                                const target = new URL(internalOrigin);
                                url.host = target.host;
                                url.protocol = target.protocol;
                                return fetch(url, init);
                            },
                        }
                        : {}),
                });
            }
            const claims = await verifyLogout(
                body.logout_token,
                issuer!,
                client!,
                logoutKeys,
            );
            await revokeProviderSessions(claims, client!);
            return reply.code(200).send({ok: true});
        },
    );
    app.get("/v1/auth/login", async (req, reply) => {
        const action = identityAction(req.query, process.env.OIDC_PROVIDER);
        const c = await configured();
        const state = oidc.randomState(),
            nonce = oidc.randomNonce(),
            verifier = oidc.randomPKCECodeVerifier();
        await saveLogin(state, verifier, nonce, binding);
        reply.header(
            "Set-Cookie",
            `concord_oidc=${state}; HttpOnly; SameSite=Lax; Path=/v1/auth; Max-Age=300${redirect.startsWith("https:") ? "; Secure" : ""}`,
        );
        return reply.redirect(
            oidc.buildAuthorizationUrl(c, {
                redirect_uri: redirect,
                scope: "openid email profile",
                state,
                nonce,
                code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
                code_challenge_method: "S256",
                ...action,
                ...(requiredAcr
                    ? {
                        acr_values: requiredAcr,
                        claims: JSON.stringify({
                            id_token: {acr: {essential: true, values: [requiredAcr]}},
                        }),
                    }
                    : {}),
            }).href,
        );
    });
    app.get("/v1/auth/callback", async (req, reply) => {
        const c = await configured();
        const url = new URL(req.url, new URL(redirect).origin);
        const state = url.searchParams.get("state") ?? "";
        const cookie = req.headers.cookie
            ?.split(";")
            .map((x) => x.trim())
            .find((x) => x.startsWith("concord_oidc="))
            ?.slice(13);
        const flow = await consumeLogin(state, cookie, binding);
        reply.header(
            "Set-Cookie",
            `concord_oidc=; HttpOnly; SameSite=Lax; Path=/v1/auth; Max-Age=0${redirect.startsWith("https:") ? "; Secure" : ""}`,
        );
        const token = await oidc.authorizationCodeGrant(c, url, {
            pkceCodeVerifier: flow.verifier,
            expectedState: state,
            expectedNonce: flow.nonce,
            idTokenExpected: true,
        });
        const claims = token.claims();
        if (!claims?.sub) throw new HttpError(401, "Invalid identity");
        if (requiredAcr && claims.acr !== requiredAcr)
            throw new HttpError(
                403,
                "Required sign-in assurance was not satisfied. Contact your administrator.",
            );
        const user = await pool.query(
            "SELECT id FROM users WHERE oidc_subject=$1 AND NOT disabled",
            [`${issuer}|${claims.sub}`],
        );
        if (!user.rowCount)
            throw new HttpError(
                403,
                "Your identity has not been provisioned. Contact your administrator.",
            );
        const session = randomBytes(32).toString("hex");
        if (vault && !token.refresh_token)
            throw new HttpError(
                503,
                "Provider session verification requires a refresh token",
            );
        const credential = vault
            ? await vault.seal(
                token.refresh_token!,
                credentialBinding(hash(session), issuer!, client!, claims.sub),
            )
            : undefined;
        await createProviderSession(
            hash(session),
            user.rows[0].id,
            issuer!,
            client!,
            claims.sub,
            typeof claims.sid === "string" ? claims.sid : undefined,
            claims.iat,
            typeof claims.acr === "string" ? claims.acr : undefined,
            credential,
        );
        reply.header("Set-Cookie", [
            `concord_oidc=; HttpOnly; SameSite=Lax; Path=/v1/auth; Max-Age=0${redirect.startsWith("https:") ? "; Secure" : ""}`,
            `concord_session=${session}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800${redirect.startsWith("https:") ? "; Secure" : ""}`,
        ]);
        return reply.redirect(webOrigin);
    });
    return reconcile;
}
