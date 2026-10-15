import {registerUsage} from './usage.ts';
import {registerAuditExport} from './audit-export.ts';
import {registerAuditSearch} from './audit-search.ts';
import {registerModeration} from './moderation.ts';
import {registerPostingPolicy,requirePosting} from './posting-policy.ts';
import {registerMeetingReminders} from './meeting-reminders.ts';
import {registerNotifications} from "./notifications.ts";
import {attachFiles, attachmentProjection} from "./attachments.ts";
import {mentionProjection, mentionRecipients, replaceMentions} from "./mentions.ts";
import {authenticationFailure, authenticationRoute, identityAudit} from "./identity-audit.ts";
import Fastify, {type FastifyRequest} from "fastify";
import cors from "@fastify/cors";
import {z} from "zod";
import {randomBytes, randomUUID} from "node:crypto";
import {migrate, pool, transaction} from "./db.ts";
import {accessSQL, audit, channel, event, hash, HttpError, member, passwordMatches,} from "./security.ts";
import {registerWork} from "./work.ts";
import {registerMembership} from "./membership.ts";
import {registerFiles} from "./files.ts";
import {registerOidc} from "./oidc.ts";
import {sessionReader} from "./session-policy.ts";
import {validateConfiguration} from "./config.ts";

const uuid = z.string().uuid();
const title = z.string().trim().min(1).max(160);
const messageSchema = z.object({
    clientId: uuid,
    attachmentIds: z.array(uuid.transform(v => v.toLowerCase())).max(10).default([]).refine(v => new Set(v).size === v.length, "Duplicate attachment").transform(v => v.sort()),
    format: z.enum(["plain", "markdown-v1"]).default("plain"),
    body: z.string().trim().min(1).max(10000),
    parentId: uuid.nullable().optional(),
});
const origins = (process.env.WEB_ORIGIN ?? "http://localhost:3100").split(",");
const production = process.env.NODE_ENV === "production";
export type User = {
    id: string;
    email: string;
    name: string;
    title: string;
    timezone: string;
    status: string;
    preferences: Record<string, unknown>;
};
declare module "fastify" {
    interface FastifyRequest {
        user: User;
    }
}
export const idParam = (req: FastifyRequest, key = "id") =>
    uuid.parse((req.params as Record<string, string>)[key]);

export async function createApp() {
    validateConfiguration();
    const app = Fastify({
        requestIdHeader: false,
        genReqId: () => randomUUID(),
        bodyLimit: 128 * 1024,
        requestTimeout: 15000,
        logger:
            process.env.LOG_LEVEL === "silent"
                ? false
                : {
                    level: process.env.LOG_LEVEL ?? "info",
                    redact: ["req.headers.cookie", "req.headers.authorization"],
                    serializers: {
                        req: (r) => ({method: r.method, url: r.url?.split("?")[0]}),
                    },
                },
    });
    await app.register(cors, {
        origin: origins,
        credentials: true,
        methods: ["GET", "POST", "PATCH", "DELETE", "PUT", "OPTIONS"],
    });
    const rates = new Map<string, { count: number; reset: number }>();
    const cleaner = setInterval(() => {
        for (const [key, value] of rates)
            if (value.reset < Date.now()) rates.delete(key);
    }, 60000);
    cleaner.unref();
    app.addHook("onClose", async () => {
        clearInterval(cleaner);
    });
    app.addHook("onRequest", async (req, reply) => {
        reply
            .header("Cache-Control", "no-store")
            .header("X-Content-Type-Options", "nosniff")
            .header("X-Request-Id", req.id);
        if (req.method === "OPTIONS") return;
        const backchannel = req.method === "POST" && req.url === "/v1/auth/backchannel-logout";
        const authentication = (req.url === "/v1/session" && req.method === "POST") || req.url.startsWith("/v1/auth/");
        const key = req.ip + (backchannel ? ":provider" : authentication ? ":login" : ":api");
        const limit = backchannel ? 600 : authentication ? 60 : 1200;
        const rate = rates.get(key) ?? {count: 0, reset: Date.now() + 60000};
        if (rate.reset < Date.now()) {
            rate.count = 0;
            rate.reset = Date.now() + 60000;
        }
        rates.set(key, rate);
        if (++rate.count > limit) {
            reply.header("Retry-After", Math.max(1, Math.ceil((rate.reset - Date.now()) / 1000)));
            throw new HttpError(429, "Too many requests. Try again in a minute.");
        }
        if (
            !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
            !origins.includes(String(req.headers.origin)) &&
            !(req.method === "POST" && req.url === "/v1/auth/backchannel-logout")
        )
            throw new HttpError(403, "Untrusted request origin");
        if (
            req.url === "/health" ||
            req.url === "/ready" ||
            req.url === "/v1/capabilities" ||
            req.url.startsWith("/v1/auth/") ||
            (req.url === "/v1/session" && req.method === "POST")
        )
            return;
        const token = req.headers.cookie
            ?.split(";")
            .map((x) => x.trim())
            .find((x) => x.startsWith("concord_session="))
            ?.slice(16);
        if (!token) throw new HttpError(401, "Sign in to continue");
        const u = await readSession(hash(token));
        if (!u.rowCount)
            throw new HttpError(401, "Your session expired. Sign in again.");
        req.user = u.rows[0];
    });
    app.setErrorHandler(async (error, req, reply) => {
        const authRoute = authenticationRoute(req.method, req.routeOptions.url);
        const status = error instanceof z.ZodError ? 400 : (error as { statusCode?: number }).statusCode ?? 500;
        if (authRoute && status !== 429) {
            try {
                await authenticationFailure(pool, authRoute, status, req.id);
            } catch {
                req.log.error({requestId: req.id}, "Authentication audit unavailable");
                return reply.code(503).send({
                    error: "Service temporarily unavailable. Retry shortly.",
                    correlationId: req.id
                });
            }
        }
        if (error instanceof z.ZodError)
            return reply.code(400).send({
                error: "Invalid input",
                details: error.issues.map((x) => ({
                    path: x.path,
                    message: x.message,
                })),
                correlationId: req.id,
            });
        const e = error as Error & { statusCode?: number; code?: string };
        const code = e.statusCode ?? (e.code === "23505" ? 409 : 500);
        if (code >= 500)
            req.log.error({code: e.code, requestId: req.id}, "Request failed");
        return reply.code(code).send({
            error:
                code >= 500
                    ? "Service temporarily unavailable. Retry shortly."
                    : authRoute && !(error instanceof HttpError)
                        ? "Sign-in could not be completed. Start again."
                        : e.message,
            correlationId: req.id,
        });
    });
    app.get("/health", async () => ({status: "ok", release: "0.1.41"}));
    app.get("/ready", async () => {
        await pool.query("SELECT 1");
        return {status: "ready"};
    });
    app.get("/v1/capabilities", async () => ({
        developmentAuth: process.env.DEV_AUTH === "true",
        oidc: !!process.env.OIDC_ISSUER,
        recoveryCodes: !!process.env.OIDC_ISSUER && !!process.env.OIDC_CLIENT_ID && process.env.OIDC_PROVIDER === "keycloak",
        media: {
            state: "unconfigured",
            reason:
                "LiveKit endpoint, credentials, and verified media integration required",
        },
        encryption: {
            state: "unavailable",
            reason:
                "Endpoint key lifecycle and maintained protocol integration are not implemented. Messages are server-processable.",
        },
        calendar: {
            state: "unconfigured",
            reason:
                "External calendar provider consent is required; local scheduling is available",
        },
        email: {state: "unconfigured", reason: "SMTP delivery not configured"},
        editor: {
            state: "unconfigured",
            reason: "Collaborative editor provider not configured",
        },
        telephony: {
            state: "unconfigured",
            reason: "SIP/PSTN trunk, numbers, and provider authorization required",
        },
    }));
    app.post("/v1/session", async (req, reply) => {
        if (process.env.DEV_AUTH !== "true" || production)
            throw new HttpError(403, "Use enterprise sign-in");
        const b = z
            .object({email: z.email(), password: z.string().max(200)})
            .parse(req.body);
        const r = await pool.query(
            "SELECT * FROM users WHERE email=$1 AND NOT disabled",
            [b.email.toLowerCase()],
        );
        if (
            !r.rowCount ||
            !r.rows[0].password_hash ||
            !passwordMatches(b.password, r.rows[0].password_hash)
        )
            throw new HttpError(401, "Email or password incorrect");
        const token = randomBytes(32).toString("hex");
        await transaction(async (db) => {
            await db.query(
                "INSERT INTO sessions VALUES($1,$2,now()+interval '8 hours',now())",
                [hash(token), r.rows[0].id],
            );
            await identityAudit(db, r.rows[0].id, "identity.signed_in", {method: "development"});
        });
        reply.header(
            "Set-Cookie",
            `concord_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800${production ? "; Secure" : ""}`,
        );
        return {ok: true};
    });
    app.get("/v1/session", async (req) => ({
        user: req.user,
        organizations: (
            await pool.query(
                "SELECT o.*,m.role FROM organizations o JOIN memberships m ON m.org_id=o.id WHERE m.user_id=$1 AND m.active ORDER BY o.name",
                [req.user.id],
            )
        ).rows,
    }));
    app.delete("/v1/session", async (req, reply) => {
        const token = req.headers.cookie
            ?.split(";")
            .map((x) => x.trim())
            .find((x) => x.startsWith("concord_session="))
            ?.slice(16);
        if (token)
            await transaction(async (db) => {
                const removed = await db.query("DELETE FROM sessions WHERE token_hash=$1 RETURNING user_id", [hash(token)]);
                if (removed.rowCount)
                    await identityAudit(db, removed.rows[0].user_id, "identity.signed_out");
            });
        reply.header(
            "Set-Cookie",
            "concord_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
        );
        return {ok: true};
    });
    app.patch("/v1/profile", async (req) => {
        const b = z
            .object({
                name: title,
                title: z.string().max(160),
                timezone: z.string().max(80),
                status: z.string().max(200),
                preferences: z.object({
                    theme: z.enum(["light", "dark"]).optional(),
                    readReceipts: z.boolean().optional(),
                    quietHours: z.boolean().optional(),
                    language: z.enum(["en", "ar"]).optional(),
                }),
            })
            .parse(req.body);
        try {
            new Intl.DateTimeFormat("en", {timeZone: b.timezone});
        } catch {
            throw new HttpError(400, "Invalid timezone");
        }
        await pool.query(
            "UPDATE users SET name=$1,title=$2,timezone=$3,status=$4,preferences=$5 WHERE id=$6",
            [b.name, b.title, b.timezone, b.status, b.preferences, req.user.id],
        );
        return {ok: true};
    });
    app.get("/v1/organizations/:id/bootstrap", async (req) => {
        const org = idParam(req);
        const membership = await member(pool, req.user.id, org);
        const [teams, channels, people] = await Promise.all([
            pool.query(
                "SELECT t.* FROM teams t JOIN team_members tm ON tm.team_id=t.id WHERE t.org_id=$1 AND tm.user_id=$2 ORDER BY t.name",
                [org, req.user.id],
            ),
            pool.query(
                `SELECT c.*,coalesce(p.pinned,false) pinned,coalesce(p.muted,false) muted,coalesce(p.hidden,false) hidden,(SELECT count(*)::int FROM messages m WHERE m.channel_id=c.id AND m.seq>coalesce(r.seq,0) AND m.user_id<>$1 AND NOT m.deleted) unread,(SELECT left(body,100) FROM messages m WHERE m.channel_id=c.id AND NOT m.deleted ORDER BY seq DESC LIMIT 1) preview FROM channels c LEFT JOIN read_positions r ON r.channel_id=c.id AND r.user_id=$1 LEFT JOIN channel_preferences p ON p.channel_id=c.id AND p.user_id=$1 WHERE c.org_id=$2 AND ${accessSQL} ORDER BY c.name`,
                [req.user.id, org],
            ),
            pool.query(
                "SELECT u.id,u.name,u.email,u.title,m.role,CASE WHEN p.last_seen < now()-interval '60 seconds' OR p.last_seen IS NULL THEN 'offline' WHEN p.override_until>now() THEN p.state ELSE 'available' END presence FROM memberships m JOIN users u ON u.id=m.user_id LEFT JOIN presence p ON p.org_id=m.org_id AND p.user_id=u.id WHERE m.org_id=$1 AND m.active AND NOT u.disabled ORDER BY u.name",
                [org],
            ),
        ]);
        return {
            role: membership.role,
            teams: teams.rows,
            channels: channels.rows,
            people: people.rows,
        };
    });
    app.post("/v1/organizations/:id/presence", async (req) => {
        const org = idParam(req);
        await member(pool, req.user.id, org);
        const b = z
            .object({
                state: z
                    .enum(["available", "busy", "dnd", "away", "offline"])
                    .optional(),
                minutes: z.number().int().min(1).max(480).optional(),
            })
            .parse(req.body);
        await pool.query(
            "INSERT INTO presence(org_id,user_id,state,override_until) VALUES($1,$2,$3,CASE WHEN $4::int IS NULL THEN NULL ELSE now()+$4*interval '1 minute' END) ON CONFLICT(org_id,user_id) DO UPDATE SET last_seen=now(),state=CASE WHEN $4::int IS NULL THEN presence.state ELSE $3 END,override_until=CASE WHEN $4::int IS NULL THEN presence.override_until ELSE now()+$4*interval '1 minute' END",
            [org, req.user.id, b.state ?? "available", b.minutes ?? null],
        );
        return {ok: true};
    });
    app.post("/v1/organizations/:id/teams", async (req) => {
        const org = idParam(req);
        const actor = await member(pool, req.user.id, org);
        if (actor.role === "guest")
            throw new HttpError(403, "Guests cannot create teams");
        const b = z.object({name: title}).parse(req.body);
        return transaction(async (db) => {
            const id = randomUUID();
            await db.query("INSERT INTO teams(id,org_id,name) VALUES($1,$2,$3)", [
                id,
                org,
                b.name,
            ]);
            await db.query("INSERT INTO team_members VALUES($1,$2,$3,'owner')", [
                org,
                id,
                req.user.id,
            ]);
            await audit(db, req.user.id, org, "team.created", id);
            return {id};
        });
    });
    app.post("/v1/organizations/:id/channels", async (req) => {
        const org = idParam(req);
        const actor = await member(pool, req.user.id, org);
        const b = z
            .object({
                name: title,
                description: z.string().max(1000).default(""),
                kind: z.enum(["standard", "private", "shared", "direct", "group"]),
                teamId: uuid.nullable(),
                members: z.array(uuid).max(100).default([]),
            })
            .parse(req.body);
        if (actor.role === "guest")
            throw new HttpError(403, "Guests cannot create conversations");
        return transaction(async (db) => {
            if (b.teamId) {
                const t = await db.query(
                    "SELECT 1 FROM team_members WHERE team_id=$1 AND org_id=$2 AND user_id=$3",
                    [b.teamId, org, req.user.id],
                );
                if (!t.rowCount) throw new HttpError(404, "Team unavailable");
            } else if (!["direct", "group"].includes(b.kind))
                throw new HttpError(400, "Team required");
            const people = [...new Set([req.user.id, ...b.members])];
            if (b.kind === "direct" && people.length !== 2)
                throw new HttpError(400, "Direct chat needs two people");
            for (const person of people) await member(db, person, org);
            const id = randomUUID();
            await db.query(
                "INSERT INTO channels(id,org_id,team_id,name,description,kind) VALUES($1,$2,$3,$4,$5,$6)",
                [id, org, b.teamId, b.name, b.description, b.kind],
            );
            for (const person of people)
                await db.query("INSERT INTO channel_members VALUES($1,$2,$3)", [
                    org,
                    id,
                    person,
                ]);
            await audit(db, req.user.id, org, "channel.created", id);
            return {id};
        });
    });
    app.get("/v1/channels/:id/messages", async (req) => {
        const id = idParam(req);
        const c = await channel(pool, req.user.id, id);
        const q = z
            .object({
                before: z.coerce.number().int().positive().optional(),
                limit: z.coerce.number().int().min(1).max(100).default(50),
            })
            .parse(req.query);
        const r = await pool.query(
            `SELECT m.*,u.name,${mentionProjection},${attachmentProjection},(SELECT coalesce(json_agg(json_build_object('emoji',r.emoji,'userId',r.user_id)),'[]') FROM reactions r WHERE r.message_id=m.id) reactions,EXISTS(SELECT 1 FROM saved_messages s WHERE s.message_id=m.id AND s.user_id=$4) saved FROM messages m JOIN users u ON u.id=m.user_id WHERE m.channel_id=$1 AND ($2::bigint IS NULL OR m.seq<$2) ORDER BY m.seq DESC LIMIT $3`,
            [id, q.before ?? null, q.limit, req.user.id],
        );
        return {
            channel: c,
            messages: r.rows.reverse(),
            hasMore: r.rowCount === q.limit,
        };
    });
    app.post("/v1/channels/:id/messages", async (req, reply) => {
        const id = idParam(req);
        const b = messageSchema.parse(req.body);
        const result = await transaction(async (db) => {
            const c = await channel(db, req.user.id, id, true);
            if (c.archived) throw new HttpError(409, "This conversation is archived");
            const old = await db.query(
                "SELECT * FROM messages WHERE channel_id=$1 AND user_id=$2 AND client_id=$3",
                [id, req.user.id, b.clientId],
            );
            if (old.rowCount) {
                if (
                    old.rows[0].body !== b.body ||
                    old.rows[0].format !== b.format ||
                    JSON.stringify(old.rows[0].attachment_ids) !== JSON.stringify(b.attachmentIds) ||
                    old.rows[0].parent_id !== (b.parentId ?? null)
                )
                    throw new HttpError(
                        409,
                        "Idempotency key already used with different content",
                    );
                return old.rows[0];
            }
            await requirePosting(db,req.user.id,c);
            if (b.parentId) {
                const p = await db.query(
                    "SELECT 1 FROM messages WHERE id=$1 AND channel_id=$2 AND NOT deleted",
                    [b.parentId, id],
                );
                if (!p.rowCount) throw new HttpError(400, "Reply target unavailable");
            }
            const seq = (
                await db.query(
                    "UPDATE channels SET sequence=sequence+1 WHERE id=$1 RETURNING sequence",
                    [id],
                )
            ).rows[0].sequence;
            const m = (
                await db.query(
                    "INSERT INTO messages(id,org_id,channel_id,user_id,client_id,seq,body,parent_id,format,attachment_ids) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *",
                    [
                        randomUUID(),
                        c.org_id,
                        id,
                        req.user.id,
                        b.clientId,
                        seq,
                        b.body,
                        b.parentId ?? null,
                        b.format,
                        b.attachmentIds,
                    ],
                )
            ).rows[0];
            await attachFiles(db, m.id, id, c.org_id, b.attachmentIds);
            await replaceMentions(db, m.id, id, mentionRecipients(b.body, b.format));
            await event(db, c.org_id, id, "message.created", {id: m.id, seq});
            return m;
        });
        return reply.code(201).send(result);
    });
    app.patch("/v1/channels/:id/messages/:message", async (req) => {
        const id = idParam(req);
        const mid = idParam(req, "message");
        const b = z
            .object({body: z.string().trim().min(1).max(10000), format: z.enum(["plain", "markdown-v1"]).optional()})
            .parse(req.body);
        return transaction(async (db) => {
            const c = await channel(db, req.user.id, id, true);
            await requirePosting(db,req.user.id,c);
            const r = await db.query(
                "UPDATE messages SET body=$1,format=coalesce($5,format),edited_at=now() WHERE id=$2 AND channel_id=$3 AND user_id=$4 AND NOT deleted RETURNING id,format",
                [b.body, mid, id, req.user.id, b.format ?? null],
            );
            if (!r.rowCount) throw new HttpError(404, "Editable message unavailable");
            await replaceMentions(db, mid, id, mentionRecipients(b.body, r.rows[0].format));
            await event(db, c.org_id, id, "message.updated", {id: mid});
            return {ok: true};
        });
    });
    app.delete("/v1/channels/:id/messages/:message", async (req) => {
        const id = idParam(req);
        const mid = idParam(req, "message");
        return transaction(async (db) => {
            const c = await channel(db, req.user.id, id, true);
            const role = await member(db, req.user.id, c.org_id);
            const r = await db.query(
                "UPDATE messages SET body='',deleted=true WHERE id=$1 AND channel_id=$2 AND (user_id=$3 OR $4) RETURNING id",
                [mid, id, req.user.id, ["admin", "owner"].includes(role.role)],
            );
            if (!r.rowCount) throw new HttpError(404, "Message unavailable");
            await event(db, c.org_id, id, "message.deleted", {id: mid});
            await db.query("DELETE FROM message_mentions WHERE message_id=$1", [mid]);
            await audit(db, req.user.id, c.org_id, "message.deleted", mid);
            return {ok: true};
        });
    });
    app.post("/v1/channels/:id/messages/:message/reactions", async (req) => {
        const id = idParam(req);
        const mid = idParam(req, "message");
        const b = z
            .object({
                emoji: z.enum(["👍", "❤️", "🎉", "👀", "✅"]),
                active: z.boolean(),
            })
            .parse(req.body);
        return transaction(async (db) => {
            const c = await channel(db, req.user.id, id, true);
            if (
                !(
                    await db.query(
                        "SELECT 1 FROM messages WHERE id=$1 AND channel_id=$2 AND NOT deleted",
                        [mid, id],
                    )
                ).rowCount
            )
                throw new HttpError(404, "Message unavailable");
            if (b.active)
                await db.query(
                    "INSERT INTO reactions VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
                    [mid, req.user.id, b.emoji],
                );
            else
                await db.query(
                    "DELETE FROM reactions WHERE message_id=$1 AND user_id=$2 AND emoji=$3",
                    [mid, req.user.id, b.emoji],
                );
            await event(db, c.org_id, id, "reaction.changed", {id: mid});
            return {ok: true};
        });
    });
    app.post("/v1/channels/:id/messages/:message/save", async (req) => {
        const id = idParam(req);
        const mid = idParam(req, "message");
        await channel(pool, req.user.id, id);
        const b = z.object({saved: z.boolean()}).parse(req.body);
        if (
            !(
                await pool.query(
                    "SELECT 1 FROM messages WHERE id=$1 AND channel_id=$2",
                    [mid, id],
                )
            ).rowCount
        )
            throw new HttpError(404, "Message unavailable");
        if (b.saved)
            await pool.query(
                "INSERT INTO saved_messages VALUES($1,$2) ON CONFLICT DO NOTHING",
                [mid, req.user.id],
            );
        else
            await pool.query(
                "DELETE FROM saved_messages WHERE message_id=$1 AND user_id=$2",
                [mid, req.user.id],
            );
        return {ok: true};
    });
    app.get("/v1/channels/:id/draft", async (req) => {
        const id = idParam(req);
        await channel(pool, req.user.id, id);
        return {
            body:
                (
                    await pool.query(
                        "SELECT body FROM drafts WHERE channel_id=$1 AND user_id=$2",
                        [id, req.user.id],
                    )
                ).rows[0]?.body ?? "",
        };
    });
    app.put("/v1/channels/:id/draft", async (req) => {
        const id = idParam(req);
        await channel(pool, req.user.id, id);
        const b = z.object({body: z.string().max(10000)}).parse(req.body);
        await pool.query(
            "INSERT INTO drafts VALUES($1,$2,$3,now()) ON CONFLICT(channel_id,user_id) DO UPDATE SET body=$3,updated_at=now()",
            [id, req.user.id, b.body],
        );
        return {ok: true};
    });
    app.post("/v1/channels/:id/read", async (req) => {
        const id = idParam(req);
        const b = z
            .object({seq: z.coerce.number().int().nonnegative()})
            .parse(req.body);
        return transaction(async (db) => {
            const c = await channel(db, req.user.id, id, true);
            if (b.seq > Number(c.sequence))
                throw new HttpError(400, "Read position exceeds history");
            await db.query(
                "INSERT INTO read_positions VALUES($1,$2,$3) ON CONFLICT(channel_id,user_id) DO UPDATE SET seq=GREATEST(read_positions.seq,$3)",
                [id, req.user.id, b.seq],
            );
            await event(db, c.org_id, id, "read.changed");
            return {ok: true};
        });
    });
    app.get("/v1/channels/:id/receipts", async (req) => {
        const id = idParam(req);
        await channel(pool, req.user.id, id);
        return {
            receipts: (
                await pool.query(
                    `SELECT r.user_id,u.name,r.seq FROM read_positions r JOIN users u ON u.id=r.user_id JOIN channels c ON c.id=r.channel_id WHERE r.channel_id=$1 AND coalesce((u.preferences->>'readReceipts')::boolean,true) AND EXISTS(SELECT 1 FROM memberships m WHERE m.org_id=c.org_id AND m.user_id=u.id AND m.active) AND (c.kind='standard' AND EXISTS(SELECT 1 FROM team_members t WHERE t.team_id=c.team_id AND t.user_id=u.id) OR c.kind<>'standard' AND EXISTS(SELECT 1 FROM channel_members cm WHERE cm.channel_id=c.id AND cm.user_id=u.id)) ORDER BY u.name LIMIT 100`,
                    [id],
                )
            ).rows,
        };
    });
    app.patch("/v1/channels/:id/preferences", async (req) => {
        const id = idParam(req);
        await channel(pool, req.user.id, id);
        const b = z
            .object({pinned: z.boolean(), muted: z.boolean(), hidden: z.boolean()})
            .parse(req.body);
        await pool.query(
            "INSERT INTO channel_preferences VALUES($1,$2,$3,$4,$5) ON CONFLICT(channel_id,user_id) DO UPDATE SET pinned=$3,muted=$4,hidden=$5",
            [id, req.user.id, b.pinned, b.muted, b.hidden],
        );
        return {ok: true};
    });
    const typing = new Map<
        string,
        Map<string, { name: string; until: number }>
    >();
    app.post("/v1/channels/:id/typing", async (req) => {
        const id = idParam(req);
        await channel(pool, req.user.id, id);
        const state = typing.get(id) ?? new Map();
        state.set(req.user.id, {name: req.user.name, until: Date.now() + 5000});
        typing.set(id, state);
        return {ok: true};
    });
    app.get("/v1/channels/:id/typing", async (req) => {
        const id = idParam(req);
        await channel(pool, req.user.id, id);
        const state = typing.get(id);
        const people = [];
        if (state)
            for (const [u, t] of state) {
                if (t.until < Date.now()) state.delete(u);
                else if (u !== req.user.id) people.push(t.name);
            }
        if (state?.size === 0) typing.delete(id);
        return {people};
    });
    const connectionCounts = new Map<string, number>();
    app.get("/v1/channels/:id/events", async (req, reply) => {
        const id = idParam(req);
        await channel(pool, req.user.id, id);
        const count = connectionCounts.get(req.user.id) ?? 0;
        if (count >= 10) throw new HttpError(429, "Too many live windows");
        let cursor = z.coerce
            .number()
            .int()
            .nonnegative()
            .parse(
                req.headers["last-event-id"] ??
                (req.query as { after?: string }).after ??
                0,
            );
        connectionCounts.set(req.user.id, count + 1);
        reply.raw.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-store",
            Connection: "keep-alive",
            "Access-Control-Allow-Origin": origins.includes(
                String(req.headers.origin),
            )
                ? String(req.headers.origin)
                : origins[0],
            "Access-Control-Allow-Credentials": "true",
            "X-Accel-Buffering": "no",
        });
        reply.hijack();
        let busy = false;
        let closed = false;
        const close = () => {
            if (closed) return;
            closed = true;
            clearInterval(timer);
            connectionCounts.set(
                req.user.id,
                Math.max(0, (connectionCounts.get(req.user.id) ?? 1) - 1),
            );
            reply.raw.end();
        };
        const send = (data: string) => {
            if (reply.raw.writableLength > 65536 || !reply.raw.write(data)) close();
        };
        const tick = async () => {
            if (busy || closed) return;
            busy = true;
            try {
                const session = req.headers.cookie
                    ?.split(";")
                    .map((x) => x.trim())
                    .find((x) => x.startsWith("concord_session="))
                    ?.slice(16);
                if (
                    !(
                        await readSession(hash(session ?? ""))
                    ).rowCount
                )
                    throw new HttpError(401, "Session ended");
                await channel(pool, req.user.id, id);
                const r = await pool.query(
                    "SELECT id,type FROM outbox WHERE channel_id=$1 AND id>$2 ORDER BY id LIMIT 100",
                    [id, cursor],
                );
                for (const e of r.rows) {
                    send(`id: ${e.id}\ndata: ${JSON.stringify(e)}\n\n`);
                    cursor = Number(e.id);
                }
                if (!r.rowCount) send(": heartbeat\n\n");
            } catch (error) {
                if (error instanceof HttpError && error.statusCode === 401)
                    send("event: session-ended\ndata: {}\n\n");
                else if (error instanceof HttpError && [403, 404].includes(error.statusCode))
                    send("event: revoked\ndata: {}\n\n");
                close();
            } finally {
                busy = false;
            }
        };
        const timer = setInterval(tick, 1000);
        req.raw.on("close", close);
        await tick();
    });
    app.get("/v1/organizations/:id/search", async (req) => {
        const org = idParam(req);
        await member(pool, req.user.id, org);
        const q = z
            .object({q: z.string().trim().min(1).max(200)})
            .parse(req.query);
        return {
            results: (
                await pool.query(
                    `SELECT m.id,m.body,m.channel_id,c.name channel_name,u.name author,m.created_at FROM messages m JOIN channels c ON c.id=m.channel_id JOIN users u ON u.id=m.user_id WHERE c.org_id=$2 AND ${accessSQL} AND NOT m.deleted AND to_tsvector('english',m.body) @@ plainto_tsquery('english',$3) ORDER BY m.created_at DESC LIMIT 50`,
                    [req.user.id, org, q.q],
                )
            ).rows,
        };
    });
    app.get("/v1/organizations/:id/activity", async (req) => {
        const org = idParam(req);
        await member(pool, req.user.id, org);
        const q = z.object({filter: z.enum(["unread", "mentions", "replies"]).default("unread")}).parse(req.query);
        return {
            items: (await pool.query(
                `SELECT m.id,m.body,m.format,${mentionProjection},m.channel_id,c.name channel_name,u.name author,m.created_at,
       EXISTS(SELECT 1 FROM message_mentions mm WHERE mm.message_id=m.id AND mm.user_id=$1) mentioned,
       EXISTS(SELECT 1 FROM messages parent WHERE parent.id=m.parent_id AND parent.channel_id=m.channel_id AND parent.org_id=m.org_id AND parent.user_id=$1 AND NOT parent.deleted) replied
       FROM messages m JOIN channels c ON c.id=m.channel_id JOIN users u ON u.id=m.user_id
       LEFT JOIN read_positions r ON r.channel_id=c.id AND r.user_id=$1
       WHERE c.org_id=$2 AND ${accessSQL} AND m.user_id<>$1 AND NOT m.deleted
       AND (($3='unread' AND m.seq>coalesce(r.seq,0)) OR ($3='mentions' AND EXISTS(SELECT 1 FROM message_mentions mm WHERE mm.message_id=m.id AND mm.user_id=$1)) OR ($3='replies' AND EXISTS(SELECT 1 FROM messages parent WHERE parent.id=m.parent_id AND parent.channel_id=m.channel_id AND parent.org_id=m.org_id AND parent.user_id=$1 AND NOT parent.deleted)))
       ORDER BY m.created_at DESC,m.id DESC LIMIT 50`, [req.user.id, org, q.filter]
            )).rows
        };
    });
    app.post("/v1/organizations/:id/feedback", async (req) => {
        const org = idParam(req);
        await member(pool, req.user.id, org);
        const b = z
            .object({body: z.string().trim().min(1).max(4000)})
            .parse(req.body);
        const id = randomUUID();
        await pool.query(
            "INSERT INTO feedback(id,org_id,user_id,body) VALUES($1,$2,$3,$4)",
            [id, org, req.user.id, b.body],
        );
        return {id};
    });
    await registerMembership(app);
    await registerWork(app);
    await registerFiles(app);
  await registerNotifications(app);
  await registerPostingPolicy(app);
  await registerModeration(app);
  await registerAuditSearch(app);
  await registerAuditExport(app);
  await registerUsage(app);
  await registerMeetingReminders(app);
    const reconcile = await registerOidc(app, origins[0]);
    const readSession = sessionReader(process.env, reconcile);
    return app;
}

if (process.argv[1]?.endsWith("server.ts")) {
    validateConfiguration();
    await migrate();
    const app = await createApp();
    await app.listen({
        host: process.env.API_HOST ?? "127.0.0.1",
        port: Number(process.env.PORT ?? 4100),
    });
    let closing = false;
    for (const signal of ["SIGTERM", "SIGINT"])
        process.on(signal, async () => {
            if (closing) return;
            closing = true;
            setTimeout(() => process.exit(1), 10000).unref();
            await app.close();
            await pool.end();
            process.exit(0);
        });
}
