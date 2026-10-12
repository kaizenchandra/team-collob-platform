import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { pool, transaction, type DB } from "./db.ts";
import { member, channel, audit, event, HttpError } from "./security.ts";
import { idParam } from "./server.ts";
const uuid = z.string().uuid();
const text = z.string().trim().min(1).max(500);
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
    from: { kind: c.kind, teamId: c.team_id, members: old },
    to: { kind: b.kind, teamId: b.teamId, members: next },
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
      return { id: task };
    });
  });
  app.patch("/v1/channels/:id/tasks/:task", async (req) => {
    const id = idParam(req);
    const task = idParam(req, "task");
    const b = z
      .object({ status: z.enum(["todo", "doing", "done"]) })
      .parse(req.body);
    return transaction(async (db) => {
      const c = await channel(db, req.user.id, id, true);
      const r = await db.query(
        "UPDATE tasks SET status=$1 WHERE id=$2 AND channel_id=$3 RETURNING id",
        [b.status, task, id],
      );
      if (!r.rowCount) throw new HttpError(404, "Task unavailable");
      await event(db, c.org_id, id, "task.updated");
      return { ok: true };
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
    const b = z.object({ body: text }).parse(req.body);
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
      return { ok: true };
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
      .object({ title: text, questions: z.array(text).min(1).max(20) })
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
      return { id: form };
    });
  });
  app.post("/v1/channels/:id/forms/:form/responses", async (req) => {
    const id = idParam(req),
      form = idParam(req, "form");
    const b = z
      .object({ answers: z.array(z.string().max(2000)).max(20) })
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
      return { ok: true };
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
  app.get("/v1/organizations/:id/meetings", async (req) => {
    const org = idParam(req);
    await member(pool, req.user.id, org);
    return {
      meetings: (
        await pool.query(
          "SELECT m.*,a.response FROM meetings m LEFT JOIN meeting_attendees a ON a.meeting_id=m.id AND a.user_id=$2 WHERE m.org_id=$1 AND (m.organizer_id=$2 OR a.user_id=$2) ORDER BY starts_at LIMIT 100",
          [org, req.user.id],
        )
      ).rows,
    };
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
    if (b.startsAt >= b.endsAt)
      throw new HttpError(400, "End must be after start");
    try {
      new Intl.DateTimeFormat("en", { timeZone: b.timezone });
    } catch {
      throw new HttpError(400, "Invalid timezone");
    }
    return transaction(async (db) => {
      for (const user of b.attendees) await member(db, user, org);
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
      await audit(db, req.user.id, org, "meeting.created", id);
      return { id };
    });
  });
  app.patch("/v1/organizations/:id/meetings/:meeting", async (req) => {
    const org = idParam(req),
      meeting = idParam(req, "meeting");
    await member(pool, req.user.id, org);
    const b = z
      .object({
        cancelled: z.literal(true).optional(),
        response: z.enum(["accepted", "declined", "tentative"]).optional(),
      })
      .parse(req.body);
    if (b.cancelled) {
      const r = await pool.query(
        "UPDATE meetings SET cancelled=true WHERE id=$1 AND org_id=$2 AND organizer_id=$3 RETURNING id",
        [meeting, org, req.user.id],
      );
      if (!r.rowCount) throw new HttpError(404, "Meeting unavailable");
    } else if (b.response) {
      const r = await pool.query(
        "UPDATE meeting_attendees a SET response=$1 FROM meetings m WHERE m.id=a.meeting_id AND m.id=$2 AND m.org_id=$3 AND a.user_id=$4 RETURNING a.meeting_id",
        [b.response, meeting, org, req.user.id],
      );
      if (!r.rowCount) throw new HttpError(404, "Meeting unavailable");
    }
    return { ok: true };
  });
  app.post("/v1/channels/:id/migration-preview", async (req) => {
    const id = idParam(req);
    const b = migration.parse(req.body);
    return transaction(async (db) => preview(db, req.user.id, id, b));
  });
  app.post("/v1/channels/:id/migrate", async (req) => {
    const id = idParam(req);
    const b = migration
      .extend({ preview: z.record(z.string(), z.unknown()), clientId: uuid })
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
      return { id: b.clientId, state: "complete" };
    });
  });
}
