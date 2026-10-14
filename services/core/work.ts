import type {FastifyInstance} from "fastify";
import {z} from "zod";
import {randomUUID} from "node:crypto";
import {type DB, pool, transaction} from "./db.ts";
import {audit, channel, event, HttpError, member} from "./security.ts";
import {idParam} from "./server.ts";

const uuid = z.string().uuid();
const text = z.string().trim().min(1).max(500);
async function eligibleAttendees(db:DB,org:string,users:string[]){
    const unique=[...new Set(users)];
    const r=await db.query("SELECT u.id FROM users u JOIN memberships m ON m.user_id=u.id WHERE m.org_id=$1 AND m.active AND NOT u.disabled AND u.id=ANY($2::uuid[])",[org,unique]);
    if(r.rowCount!==unique.length)throw new HttpError(404,"One or more attendees are unavailable in this workspace");
}

async function calendarChanged(db:DB,org:string,users:string[]){
    await db.query(`INSERT INTO calendar_versions(org_id,user_id,revision)
        SELECT $1,m.user_id,1 FROM memberships m WHERE m.org_id=$1 AND m.user_id=ANY($2::uuid[]) ORDER BY m.user_id
        ON CONFLICT(org_id,user_id) DO UPDATE SET revision=calendar_versions.revision+1`,[org,[...new Set(users)]]);
}
async function calendarRecipients(db:DB,id:string,organizer:string){
    return [organizer,...(await db.query("SELECT user_id FROM meeting_attendees WHERE meeting_id=$1",[id])).rows.map(r=>r.user_id)];
}

async function readers(
    db: DB,
    c: { kind: string; id: string; team_id: string; org_id: string },
) {
    return (
        await db.query(
            c.kind === "standard"
                ? "SELECT tm.user_id FROM team_members tm JOIN memberships m ON m.org_id=tm.org_id AND m.user_id=tm.user_id WHERE tm.team_id=$1 AND m.active ORDER BY tm.user_id"
                : "SELECT cm.user_id FROM channel_members cm JOIN memberships m ON m.org_id=cm.org_id AND m.user_id=cm.user_id WHERE cm.channel_id=$1 AND m.active ORDER BY cm.user_id",
            [c.kind === "standard" ? c.team_id : c.id],
        )
    ).rows.map((r) => r.user_id as string);
}

const migration = z.object({
    kind: z.enum(["standard", "private", "shared"]),
    teamId: uuid,
    members: z.array(uuid).max(100),
});

async function preview(
    db: DB,
    user: string,
    id: string,
    b: z.infer<typeof migration>,
) {
    const c = await channel(db, user, id, true);
    await member(db, user, c.org_id, true);
    if (["direct", "group"].includes(c.kind))
        throw new HttpError(400, "Chat migration is unsupported");
    const team = await db.query(
        "SELECT id FROM teams WHERE id=$1 AND org_id=$2 AND NOT archived FOR UPDATE",
        [b.teamId, c.org_id],
    );
    if (!team.rowCount) throw new HttpError(404, "Destination team unavailable");
    for (const person of b.members) await member(db, person, c.org_id);
    const old = await readers(db, c);
    let next = b.members;
    if (b.kind === "standard")
        next = (
            await db.query(
                "SELECT t.user_id FROM team_members t JOIN memberships m ON m.user_id=t.user_id AND m.org_id=t.org_id WHERE t.team_id=$1 AND m.active ORDER BY t.user_id",
                [b.teamId],
            )
        ).rows.map((r) => r.user_id);
    else next = [...new Set([user, ...next])].sort();
    return {
        revision: c.revision,
        from: {kind: c.kind, teamId: c.team_id, members: old},
        to: {kind: b.kind, teamId: b.teamId, members: next},
        granted: next.filter((u) => !old.includes(u)),
        revoked: old.filter((u) => !next.includes(u)),
        history:
            "Granted members gain all server-processable history; revoked members lose server access. Previously downloaded content cannot be recalled.",
        orgId: c.org_id,
    };
}

export async function registerWork(app: FastifyInstance) {
    app.get("/v1/channels/:id/tasks", async (req) => {
        const id = idParam(req);
        await channel(pool, req.user.id, id);
        return {
            tasks: (
                await pool.query(
                    "SELECT t.*,u.name assignee FROM tasks t LEFT JOIN users u ON u.id=t.assignee_id WHERE channel_id=$1 ORDER BY created_at DESC LIMIT 100",
                    [id],
                )
            ).rows,
        };
    });
    app.post("/v1/channels/:id/tasks", async (req) => {
        const id = idParam(req);
        const b = z
            .object({
                title: text,
                assigneeId: uuid.nullable(),
                priority: z.enum(["low", "normal", "high"]),
                dueDate: z.iso.date().nullable(),
            })
            .parse(req.body);
        return transaction(async (db) => {
            const c = await channel(db, req.user.id, id, true);
            if (c.kind !== "private")
                throw new HttpError(
                    400,
                    "Task boards are available in private channels",
                );
            if (b.assigneeId) await channel(db, b.assigneeId, id);
            const task = randomUUID();
            await db.query(
                "INSERT INTO tasks(id,org_id,channel_id,title,assignee_id,priority,due_date,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
                [
                    task,
                    c.org_id,
                    id,
                    b.title,
                    b.assigneeId,
                    b.priority,
                    b.dueDate,
                    req.user.id,
                ],
            );
            await event(db, c.org_id, id, "task.created");
            return {id: task};
        });
    });
    app.patch("/v1/channels/:id/tasks/:task", async (req) => {
        const id = idParam(req);
        const task = idParam(req, "task");
        const b = z
            .object({status: z.enum(["todo", "doing", "done"])})
            .parse(req.body);
        return transaction(async (db) => {
            const c = await channel(db, req.user.id, id, true);
            const r = await db.query(
                "UPDATE tasks SET status=$1 WHERE id=$2 AND channel_id=$3 RETURNING id",
                [b.status, task, id],
            );
            if (!r.rowCount) throw new HttpError(404, "Task unavailable");
            await event(db, c.org_id, id, "task.updated");
            return {ok: true};
        });
    });
    app.get("/v1/channels/:id/tasks/:task/comments", async (req) => {
        const id = idParam(req),
            task = idParam(req, "task");
        await channel(pool, req.user.id, id);
        return {
            comments: (
                await pool.query(
                    "SELECT tc.*,u.name FROM task_comments tc JOIN tasks t ON t.id=tc.task_id JOIN users u ON u.id=tc.user_id WHERE tc.task_id=$1 AND t.channel_id=$2 ORDER BY tc.created_at",
                    [task, id],
                )
            ).rows,
        };
    });
    app.post("/v1/channels/:id/tasks/:task/comments", async (req) => {
        const id = idParam(req),
            task = idParam(req, "task");
        const b = z.object({body: text}).parse(req.body);
        return transaction(async (db) => {
            const c = await channel(db, req.user.id, id, true);
            if (
                !(
                    await db.query("SELECT 1 FROM tasks WHERE id=$1 AND channel_id=$2", [
                        task,
                        id,
                    ])
                ).rowCount
            )
                throw new HttpError(404, "Task unavailable");
            await db.query("INSERT INTO task_comments VALUES($1,$2,$3,$4,now())", [
                randomUUID(),
                task,
                req.user.id,
                b.body,
            ]);
            await event(db, c.org_id, id, "task.comment");
            return {ok: true};
        });
    });
    app.get("/v1/channels/:id/forms", async (req) => {
        const id = idParam(req);
        await channel(pool, req.user.id, id);
        return {
            forms: (
                await pool.query(
                    "SELECT f.*,r.answers my_answers FROM forms f LEFT JOIN form_responses r ON r.form_id=f.id AND r.user_id=$2 WHERE f.channel_id=$1",
                    [id, req.user.id],
                )
            ).rows,
        };
    });
    app.post("/v1/channels/:id/forms", async (req) => {
        const id = idParam(req);
        const b = z
            .object({title: text, questions: z.array(text).min(1).max(20)})
            .parse(req.body);
        return transaction(async (db) => {
            const c = await channel(db, req.user.id, id, true);
            if (c.kind !== "private")
                throw new HttpError(400, "Forms require a private channel");
            const form = randomUUID();
            await db.query("INSERT INTO forms VALUES($1,$2,$3,$4,$5,$6)", [
                form,
                c.org_id,
                id,
                b.title,
                JSON.stringify(b.questions),
                req.user.id,
            ]);
            await event(db, c.org_id, id, "form.created");
            return {id: form};
        });
    });
    app.post("/v1/channels/:id/forms/:form/responses", async (req) => {
        const id = idParam(req),
            form = idParam(req, "form");
        const b = z
            .object({answers: z.array(z.string().max(2000)).max(20)})
            .parse(req.body);
        return transaction(async (db) => {
            const c = await channel(db, req.user.id, id, true);
            const f = await db.query(
                "SELECT questions FROM forms WHERE id=$1 AND channel_id=$2",
                [form, id],
            );
            if (!f.rowCount) throw new HttpError(404, "Form unavailable");
            if (f.rows[0].questions.length !== b.answers.length)
                throw new HttpError(400, "Answer every question");
            await db.query(
                "INSERT INTO form_responses VALUES($1,$2,$3,$4,now()) ON CONFLICT(form_id,user_id) DO UPDATE SET answers=$4,created_at=now()",
                [randomUUID(), form, req.user.id, JSON.stringify(b.answers)],
            );
            await event(db, c.org_id, id, "form.response");
            return {ok: true};
        });
    });
    app.get("/v1/channels/:id/forms/:form/responses", async (req) => {
        const id = idParam(req),
            form = idParam(req, "form");
        await channel(pool, req.user.id, id);
        if (
            !(
                await pool.query(
                    "SELECT 1 FROM forms WHERE id=$1 AND channel_id=$2 AND created_by=$3",
                    [form, id, req.user.id],
                )
            ).rowCount
        )
            throw new HttpError(403, "Only the form author can view all responses");
        return {
            responses: (
                await pool.query(
                    "SELECT r.answers,u.name,r.created_at FROM form_responses r JOIN users u ON u.id=r.user_id WHERE form_id=$1",
                    [form],
                )
            ).rows,
        };
    });
    app.get("/v1/organizations/:id/calendar-version",async req=>{
        const org=idParam(req);await member(pool,req.user.id,org);
        const row=(await pool.query("SELECT revision FROM calendar_versions WHERE org_id=$1 AND user_id=$2",[org,req.user.id])).rows[0];
        return {revision:row?.revision??'0'};
    });
    app.get("/v1/organizations/:id/meetings", async (req) => {
        const org = idParam(req);
        await member(pool, req.user.id, org);
        const q=z.object({limit:z.coerce.number().int().min(1).max(100).default(50),from:z.iso.datetime().optional(),to:z.iso.datetime().optional(),afterStart:z.iso.datetime().optional(),afterId:uuid.optional()}).strict().parse(req.query);
        if(!!q.from!==!!q.to||!!q.afterStart!==!!q.afterId)throw new HttpError(400,"Provide both range or cursor fields");
        if(q.from&&q.to&&(Date.parse(q.to)<=Date.parse(q.from)||Date.parse(q.to)-Date.parse(q.from)>366*86400000))throw new HttpError(400,"Calendar range must be positive and at most 366 days");
        const rows=(await pool.query(`SELECT m.*,a.response,
            to_char(m.starts_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') cursor_start,
            CASE WHEN m.organizer_id=$2 THEN (SELECT coalesce(json_agg(ma.user_id ORDER BY ma.user_id),'[]') FROM meeting_attendees ma WHERE ma.meeting_id=m.id) ELSE NULL END attendee_ids
            FROM meetings m LEFT JOIN meeting_attendees a ON a.meeting_id=m.id AND a.user_id=$2
            WHERE m.org_id=$1 AND (m.organizer_id=$2 OR a.user_id=$2)
            AND ($3::timestamptz IS NULL OR (m.ends_at>$3 AND m.starts_at<$4::timestamptz))
            AND ($5::timestamptz IS NULL OR (m.starts_at,m.id)>($5,$6::uuid))
            ORDER BY m.starts_at,m.id LIMIT $7`,[org,req.user.id,q.from??null,q.to??null,q.afterStart??null,q.afterId??null,q.limit+1])).rows;
        const page=rows.slice(0,q.limit),last=page.at(-1);
        return {meetings:page.map(row=>{const {cursor_start,...meeting}=row;void cursor_start;return meeting;}),nextCursor:rows.length>q.limit?{startsAt:last.cursor_start,id:last.id}:null};
    });
    app.post("/v1/organizations/:id/meetings", async (req) => {
        const org = idParam(req);
        await member(pool, req.user.id, org);
        const b = z
            .object({
                title: text,
                startsAt: z.iso.datetime(),
                endsAt: z.iso.datetime(),
                timezone: z.string(),
                description: z.string().max(4000).default(""),
                attendees: z.array(uuid).max(100),
            })
            .parse(req.body);
        if (Date.parse(b.startsAt) >= Date.parse(b.endsAt))
            throw new HttpError(400, "End must be after start");
        try {
            new Intl.DateTimeFormat("en", {timeZone: b.timezone});
        } catch {
            throw new HttpError(400, "Invalid timezone");
        }
        return transaction(async (db) => {
            await eligibleAttendees(db,org,b.attendees);
            const id = randomUUID();
            await db.query(
                "INSERT INTO meetings(id,org_id,title,starts_at,ends_at,timezone,organizer_id,description) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
                [
                    id,
                    org,
                    b.title,
                    b.startsAt,
                    b.endsAt,
                    b.timezone,
                    req.user.id,
                    b.description,
                ],
            );
            for (const u of new Set([req.user.id, ...b.attendees]))
                await db.query("INSERT INTO meeting_attendees VALUES($1,$2,$3)", [
                    id,
                    u,
                    u === req.user.id ? "accepted" : "pending",
                ]);
            await calendarChanged(db,org,[req.user.id,...b.attendees]);
            await audit(db, req.user.id, org, "meeting.created", id);
            return {id};
        });
    });
    app.put("/v1/organizations/:id/meetings/:meeting/details", async req => {
        const org=idParam(req),id=idParam(req,"meeting");
        await member(pool,req.user.id,org);
        const b=z.object({revision:z.number().int().positive(),title:text,description:z.string().max(4000),startsAt:z.iso.datetime(),endsAt:z.iso.datetime(),timezone:z.string().max(100),attendees:z.array(uuid).max(100).optional()}).strict().parse(req.body);
        if(Date.parse(b.startsAt)>=Date.parse(b.endsAt))throw new HttpError(400,"End must be after start");
        try{new Intl.DateTimeFormat("en",{timeZone:b.timezone});}catch{throw new HttpError(400,"Invalid timezone");}
        return transaction(async db=>{
            const row=(await db.query("SELECT * FROM meetings WHERE id=$1 AND org_id=$2 AND organizer_id=$3 FOR UPDATE",[id,org,req.user.id])).rows[0];
            if(!row)throw new HttpError(404,"Meeting unavailable");
            if(row.cancelled)throw new HttpError(409,"Cancelled meetings cannot be edited");
            if(row.revision!==b.revision)throw new HttpError(409,"Meeting changed. Close this editor, refresh the calendar, and reopen the latest meeting.");
            const priorRecipients=await calendarRecipients(db,id,req.user.id);
            let added=0,removed=0;
            if(b.attendees!==undefined){
                await eligibleAttendees(db,org,b.attendees);
                const roster=[...new Set([req.user.id,...b.attendees])];
                const deleted=await db.query("DELETE FROM meeting_attendees WHERE meeting_id=$1 AND NOT(user_id=ANY($2::uuid[])) RETURNING user_id",[id,roster]);removed=deleted.rowCount??0;
                const inserted=await db.query("INSERT INTO meeting_attendees(meeting_id,user_id,response) SELECT $1,u,CASE WHEN u=$3::uuid THEN 'accepted' ELSE 'pending' END FROM unnest($2::uuid[]) u ON CONFLICT DO NOTHING RETURNING user_id",[id,roster,req.user.id]);added=inserted.rowCount??0;
            }
            const rescheduled=new Date(row.starts_at).getTime()!==Date.parse(b.startsAt)||new Date(row.ends_at).getTime()!==Date.parse(b.endsAt);
            await db.query("UPDATE meetings SET title=$2,description=$3,starts_at=$4,ends_at=$5,timezone=$6,revision=revision+1 WHERE id=$1",[id,b.title,b.description,b.startsAt,b.endsAt,b.timezone]);
            if(rescheduled)await db.query("UPDATE meeting_attendees SET response='pending' WHERE meeting_id=$1 AND user_id<>$2",[id,req.user.id]);
            await calendarChanged(db,org,[...priorRecipients,...await calendarRecipients(db,id,req.user.id)]);
            await audit(db,req.user.id,org,"meeting.updated",id,{rescheduled,revision:row.revision+1,attendeesAdded:added,attendeesRemoved:removed});
            return {revision:row.revision+1,rescheduled};
        });
    });
    app.patch("/v1/organizations/:id/meetings/:meeting", async req => {
        const org=idParam(req),meeting=idParam(req,"meeting");await member(pool,req.user.id,org);
        const b=z.union([z.object({cancelled:z.literal(true)}).strict(),z.object({response:z.enum(["accepted","declined","tentative"])}).strict()]).parse(req.body);
        return transaction(async db=>{
            const row=(await db.query("SELECT * FROM meetings WHERE id=$1 AND org_id=$2 FOR UPDATE",[meeting,org])).rows[0];
            if(!row)throw new HttpError(404,"Meeting unavailable");
            if("cancelled" in b){
                if(row.organizer_id!==req.user.id)throw new HttpError(404,"Meeting unavailable");
                if(!row.cancelled){await db.query("UPDATE meetings SET cancelled=true,revision=revision+1 WHERE id=$1",[meeting]);await calendarChanged(db,org,await calendarRecipients(db,meeting,row.organizer_id));await audit(db,req.user.id,org,"meeting.cancelled",meeting);}
            }else{
                const attendee=await db.query("SELECT 1 FROM meeting_attendees WHERE meeting_id=$1 AND user_id=$2",[meeting,req.user.id]);
                if(!attendee.rowCount)throw new HttpError(404,"Meeting unavailable");
                if(row.cancelled)throw new HttpError(409,"Cancelled meetings cannot receive responses");
                await db.query("UPDATE meeting_attendees SET response=$1 WHERE meeting_id=$2 AND user_id=$3",[b.response,meeting,req.user.id]);
                await calendarChanged(db,org,[req.user.id,row.organizer_id]);
                await audit(db,req.user.id,org,"meeting.responded",meeting,{response:b.response});
            }
            return {ok:true};
        });
    });
    app.post("/v1/channels/:id/migration-preview", async (req) => {
        const id = idParam(req);
        const b = migration.parse(req.body);
        return transaction(async (db) => preview(db, req.user.id, id, b));
    });
    app.post("/v1/channels/:id/migrate", async (req) => {
        const id = idParam(req);
        const b = migration
            .extend({preview: z.record(z.string(), z.unknown()), clientId: uuid})
            .parse(req.body);
        return transaction(async (db) => {
            const p = await preview(db, req.user.id, id, b);
            const old = await db.query("SELECT * FROM migration_jobs WHERE id=$1", [
                b.clientId,
            ]);
            if (old.rowCount) {
                if (
                    old.rows[0].channel_id !== id ||
                    old.rows[0].actor_id !== req.user.id
                )
                    throw new HttpError(409, "Migration key conflict");
                return old.rows[0];
            }
            if (JSON.stringify(p) !== JSON.stringify(b.preview))
                throw new HttpError(409, "Permissions changed. Review a new preview.");
            await db.query(
                "UPDATE channels SET team_id=$1,kind=$2,revision=revision+1 WHERE id=$3",
                [b.teamId, b.kind, id],
            );
            await db.query("DELETE FROM channel_members WHERE channel_id=$1", [id]);
            for (const u of p.to.members)
                await db.query("INSERT INTO channel_members VALUES($1,$2,$3)", [
                    p.orgId,
                    id,
                    u,
                ]);
            await db.query(
                "INSERT INTO migration_jobs VALUES($1,$2,$3,$4,'complete',now())",
                [b.clientId, id, req.user.id, JSON.stringify(p)],
            );
            await audit(db, req.user.id, p.orgId, "channel.migrated", id, p);
            await event(db, p.orgId, id, "permissions.changed");
            return {id: b.clientId, state: "complete"};
        });
    });
}
