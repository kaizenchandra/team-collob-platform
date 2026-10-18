import type {FastifyInstance} from "fastify";
import {z} from "zod";
import {randomBytes, randomUUID} from "node:crypto";
import {pool, transaction} from "./db.ts";
import {audit, channel, event, hash, HttpError, member} from "./security.ts";
import {idParam} from "./server.ts";

export async function registerMembership(app: FastifyInstance) {
    app.get("/v1/organizations/:id/teams", async (req) => {
        const org = idParam(req);
        await member(pool, req.user.id, org);
        return {
            teams: (
                await pool.query(
                    "SELECT t.*,EXISTS(SELECT 1 FROM team_members m WHERE m.team_id=t.id AND m.user_id=$2) joined FROM teams t WHERE org_id=$1 ORDER BY name",
                    [org, req.user.id],
                )
            ).rows,
        };
    });
    app.post("/v1/organizations/:id/teams/:team/join", async (req) => {
        const org = idParam(req),
            team = idParam(req, "team");
        const actor = await member(pool, req.user.id, org);
        if (actor.role === "guest")
            throw new HttpError(403, "Guests must be added by an administrator");
        return transaction(async (db) => {
            if (
                !(
                    await db.query(
                        "SELECT id FROM teams WHERE id=$1 AND org_id=$2 AND NOT archived FOR UPDATE",
                        [team, org],
                    )
                ).rowCount
            )
                throw new HttpError(404, "Team unavailable");
            await db.query(
                "INSERT INTO team_members VALUES($1,$2,$3,'member') ON CONFLICT DO NOTHING",
                [org, team, req.user.id],
            );
            await audit(db, req.user.id, org, "team.joined", team);
            return {ok: true};
        });
    });
    app.patch("/v1/organizations/:id/teams/:team", async (req) => {
        const org = idParam(req),
            team = idParam(req, "team");
        await member(pool, req.user.id, org, true);
        const b = z
            .object({
                name: z.string().trim().min(1).max(160),
                archived: z.boolean(),
            })
            .parse(req.body);
        return transaction(async (db) => {
            const r = await db.query(
                "UPDATE teams SET name=$1,archived=$2 WHERE id=$3 AND org_id=$4 RETURNING id",
                [b.name, b.archived, team, org],
            );
            if (!r.rowCount) throw new HttpError(404, "Team unavailable");
            await db.query(
                "UPDATE channels SET archived=$1,revision=revision+1 WHERE team_id=$2",
                [b.archived, team],
            );
            await audit(db, req.user.id, org, "team.updated", team);
            return {ok: true};
        });
    });
    app.post("/v1/organizations/:id/teams/:team/leave", async (req) => {
        const org = idParam(req),
            team = idParam(req, "team");
        await member(pool, req.user.id, org);
        return transaction(async (db) => {
            const teamRow=await db.query(
                "SELECT id FROM teams WHERE id=$1 AND org_id=$2 FOR UPDATE",
                [team, org],
            );
            if(!teamRow.rowCount)throw new HttpError(404,"Team unavailable");
            await db.query(
                "SELECT id FROM channels WHERE team_id=$1 ORDER BY id FOR UPDATE",
                [team],
            );
            await db.query("SELECT m.user_id FROM memberships m WHERE m.org_id=$1 AND (m.user_id=$3 OR EXISTS(SELECT 1 FROM team_members tm WHERE tm.team_id=$2 AND tm.user_id=m.user_id AND tm.role='owner')) ORDER BY m.user_id FOR SHARE OF m",[org,team,req.user.id]);
            await member(db,req.user.id,org);
            const owners = await db.query(
                "SELECT tm.user_id FROM team_members tm JOIN memberships m ON m.org_id=tm.org_id AND m.user_id=tm.user_id JOIN users u ON u.id=tm.user_id WHERE tm.team_id=$1 AND tm.role='owner' AND m.active AND NOT u.disabled",
                [team],
            );
            if (
                owners.rows.some((o) => o.user_id === req.user.id) &&
                owners.rowCount === 1
            )
                throw new HttpError(409, "Transfer team ownership before leaving");
            await db.query(
                "DELETE FROM team_members WHERE team_id=$1 AND org_id=$2 AND user_id=$3",
                [team, org, req.user.id],
            );
            await db.query(
                "DELETE FROM channel_members WHERE user_id=$1 AND channel_id IN(SELECT id FROM channels WHERE team_id=$2 AND kind='private')",
                [req.user.id, team],
            );
            await audit(db, req.user.id, org, "team.left", team);
            return {ok: true};
        });
    });
    app.get("/v1/channels/:id/settings", async req => transaction(async db => {
        await channel(db,req.user.id,idParam(req),true);
        const c=await channel(db,req.user.id,idParam(req));
        await member(db,req.user.id,c.org_id,true);
        if(!["standard","private","shared"].includes(c.kind))throw new HttpError(400,"Channel settings are available only for team channels");
        return {id:c.id,name:c.name,description:c.description,archived:c.archived,kind:c.kind,revision:c.revision};
    }));
    app.patch("/v1/channels/:id/details", async (req) => {
        const id = idParam(req);
        const b = z
            .object({
                name: z.string().trim().min(1).max(160),
                description: z.string().max(1000),
                archived: z.boolean(),
                revision: z.number().int().positive().optional(),
            })
            .strict().parse(req.body);
        return transaction(async (db) => {
            await channel(db, req.user.id, id, true);
            const c = await channel(db, req.user.id, id);
            if (!["direct", "group"].includes(c.kind))
                await member(db, req.user.id, c.org_id, true);
            if (c.revision !== b.revision)
                throw new HttpError(409, "Conversation changed. Refresh details before retrying.");
            if(c.team_id && !b.archived && (await db.query("SELECT archived FROM teams WHERE id=$1 AND org_id=$2",[c.team_id,c.org_id])).rows[0]?.archived)
                throw new HttpError(409,"Restore the parent team before restoring this channel.");
            if(c.name===b.name&&c.description===b.description&&c.archived===b.archived)return {ok:true,revision:c.revision,changed:false};
            await db.query(
                "UPDATE channels SET name=$1,description=$2,archived=$3,revision=revision+1 WHERE id=$4",
                [b.name, b.description, b.archived, id],
            );
            await audit(db, req.user.id, c.org_id, "channel.updated", id,{revision:c.revision+1,archived:b.archived,nameChanged:c.name!==b.name,descriptionChanged:c.description!==b.description});
            await event(db, c.org_id, id, "channel.updated",{revision:c.revision+1});
            return {ok: true,revision:c.revision+1,changed:true};
        });
    });
    app.get("/v1/channels/:id/members", async (req) => {
        const id = idParam(req);
        const c = await channel(pool, req.user.id, id);
        const r = await pool.query(
            c.kind === "standard"
                ? "SELECT u.id,u.name,m.role FROM team_members tm JOIN users u ON u.id=tm.user_id JOIN memberships m ON m.user_id=u.id AND m.org_id=tm.org_id WHERE tm.team_id=$1 AND m.active AND NOT u.disabled ORDER BY u.name"
                : "SELECT u.id,u.name,m.role FROM channel_members cm JOIN users u ON u.id=cm.user_id JOIN memberships m ON m.user_id=u.id AND m.org_id=cm.org_id WHERE cm.channel_id=$1 AND m.active AND NOT u.disabled ORDER BY u.name",
            [c.kind === "standard" ? c.team_id : id],
        );
        return {members: r.rows};
    });
    app.patch("/v1/organizations/:id/members/:user", async (req) => {
        const org = idParam(req),
            user = idParam(req, "user");
        const b = z
            .object({
                active: z.boolean(),
                role: z.enum(["owner", "admin", "member", "guest"]),
            })
            .parse(req.body);
        return transaction(async (db) => {
            const actor = await member(db, req.user.id, org, true);
            await db.query(
                "SELECT id FROM channels WHERE org_id=$1 ORDER BY id FOR UPDATE",
                [org],
            );
            await db.query(
                "SELECT user_id FROM memberships WHERE org_id=$1 ORDER BY user_id FOR UPDATE",
                [org],
            );
            const targetRow = await db.query(
                "SELECT role FROM memberships WHERE org_id=$1 AND user_id=$2",
                [org, user],
            );
            if (!targetRow.rowCount)
                throw new HttpError(404, "Membership unavailable");
            const target = targetRow.rows[0];
            if (
                (b.role === "owner" || target.role === "owner") &&
                actor.role !== "owner"
            )
                throw new HttpError(403, "Only an owner can change ownership");
            if (target.role === "owner" && (!b.active || b.role !== "owner")) {
                const owners = await db.query(
                    "SELECT 1 FROM memberships WHERE org_id=$1 AND role='owner' AND active",
                    [org],
                );
                if (owners.rowCount === 1)
                    throw new HttpError(409, "A workspace must retain an active owner");
            }
            await db.query(
                "UPDATE memberships SET role=$1,active=$2 WHERE org_id=$3 AND user_id=$4",
                [b.role, b.active, org, user],
            );
            await db.query(
                "UPDATE channels SET revision=revision+1 WHERE org_id=$1",
                [org],
            );
            await audit(db, req.user.id, org, "membership.updated", user, b);
            return {ok: true};
        });
    });
    app.get("/v1/organizations/:id/invitations", async (req) => {
        const org = idParam(req);
        await member(pool, req.user.id, org, true);
        return {
            invitations: (
                await pool.query(
                    "SELECT id,email,role,expires_at,revoked,accepted_by FROM invitations WHERE org_id=$1 ORDER BY created_at DESC LIMIT 100",
                    [org],
                )
            ).rows,
        };
    });
    app.post("/v1/organizations/:id/invitations", async (req) => {
        const org = idParam(req);
        await member(pool, req.user.id, org, true);
        const b = z
            .object({email: z.email(), role: z.enum(["member", "guest"])})
            .parse(req.body);
        const token = randomBytes(32).toString("hex"),
            id = randomUUID();
        await transaction(async (db) => {
            await db.query(
                "INSERT INTO invitations(id,org_id,email,role,token_hash,expires_at,created_by) VALUES($1,$2,$3,$4,$5,now()+interval '7 days',$6)",
                [id, org, b.email.toLowerCase(), b.role, hash(token), req.user.id],
            );
            await audit(db, req.user.id, org, "invitation.created", id);
        });
        return {
            id,
            token,
            delivery: "manual",
            notice:
                "Email delivery is not configured. Share this single-use token securely with the invited identity.",
        };
    });
    app.delete("/v1/organizations/:id/invitations/:invitation", async (req) => {
        const org = idParam(req),
            invite = idParam(req, "invitation");
        await member(pool, req.user.id, org, true);
        await pool.query(
            "UPDATE invitations SET revoked=true WHERE id=$1 AND org_id=$2",
            [invite, org],
        );
        return {ok: true};
    });
    app.get("/v1/invitations", async req => ({
        invitations: (await pool.query(`SELECT i.id,i.org_id,o.name organization,i.role,i.expires_at
            FROM invitations i JOIN organizations o ON o.id=i.org_id
            WHERE i.email=$1 AND NOT i.revoked AND i.accepted_by IS NULL AND i.expires_at>now()
            AND NOT EXISTS(SELECT 1 FROM memberships m WHERE m.org_id=i.org_id AND m.user_id=$2)
            ORDER BY i.created_at DESC,i.id DESC LIMIT 50`, [req.user.email,req.user.id])).rows
    }));
    app.delete("/v1/invitations/:id", async req => transaction(async db => {
        const r=await db.query(`UPDATE invitations SET revoked=true WHERE id=$1 AND email=$2
            AND expires_at>now() AND NOT revoked AND accepted_by IS NULL RETURNING org_id`, [idParam(req),req.user.email]);
        if(!r.rowCount)throw new HttpError(404,"Invitation unavailable for your identity");
        await audit(db,req.user.id,r.rows[0].org_id,"invitation.declined",idParam(req));
        return {ok:true};
    }));
    app.post("/v1/invitations/accept", async (req) => {
        const b = z.union([z.object({token: z.string().length(64)}).strict(),z.object({invitationId: z.uuid()}).strict()]).parse(req.body);
        return transaction(async (db) => {
            await db.query("SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE", [req.user.id]);
            const r = await db.query(
                `SELECT * FROM invitations WHERE ${"token" in b ? "token_hash" : "id"}=$1 AND email=$2 AND expires_at>now() AND NOT revoked AND accepted_by IS NULL FOR UPDATE`,
                ["token" in b ? hash(b.token) : b.invitationId, req.user.email],
            );
            if (!r.rowCount || r.rows[0].email !== req.user.email)
                throw new HttpError(404, "Invitation unavailable for your identity");
            const i = r.rows[0];
            const prior = await db.query(
                "SELECT active FROM memberships WHERE org_id=$1 AND user_id=$2",
                [i.org_id, req.user.id],
            );
            if (prior.rowCount)
                throw new HttpError(
                    409,
                    "Membership already exists; contact your administrator",
                );
            await db.query("INSERT INTO memberships VALUES($1,$2,$3,true)", [
                i.org_id,
                req.user.id,
                i.role,
            ]);
            await db.query("UPDATE invitations SET accepted_by=$1 WHERE id=$2", [
                req.user.id,
                i.id,
            ]);
            await audit(db, req.user.id, i.org_id, "invitation.accepted", i.id);
            return {orgId: i.org_id};
        });
    });
}
