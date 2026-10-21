import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, type DB } from "./db.ts";
import { member, HttpError } from "./security.ts";
import { idParam } from "./server.ts";
import { employeeVisibilitySQL } from "./organization-access.ts";
export async function validateAttendees(db: DB, org: string, ids: string[]) {
  const unique = [...new Set(ids)];
  const rows = await db.query(
    "SELECT u.id FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.org_id=$1 AND m.active AND NOT u.disabled AND u.id=ANY($2::uuid[])",
    [org, unique],
  );
  const allowed = new Set(rows.rows.map((r) => r.id));
  const invalid = unique.filter((id) => !allowed.has(id));
  if (invalid.length)
    throw new HttpError(
      404,
      `Attendees no longer eligible: ${invalid.join(", ")}. Remove these attendees and try again.`,
    );
}
const paging = z
  .object({
    q: z.string().trim().max(160).default(""),
    afterName: z.string().max(1000).optional(),
    afterId: z.uuid().optional(),
  })
  .strict()
  .refine((v) => !!v.afterName === !!v.afterId, "Provide both cursor fields");
export async function registerAttendeeOptions(app: FastifyInstance) {
  const base = `FROM memberships m JOIN users u ON u.id=m.user_id LEFT JOIN organization_people e ON e.org_id=m.org_id AND e.user_id=u.id WHERE m.org_id=$1 AND m.active AND NOT u.disabled AND ${employeeVisibilitySQL}`;
  app.get("/v1/organizations/:id/attendee-options", async (req) => {
    const org = idParam(req),
      m = await member(pool, req.user.id, org),
      q = paging.parse(req.query);
    if (!q.q) return { people: [], nextCursor: null };
    const rows = (
      await pool.query(
        `SELECT u.id,u.name,u.email,u.title,lower(u.name) cursor_name ${base} AND u.id<>$2 AND (u.name ILIKE $4 OR u.email ILIKE $4) AND ($5::text IS NULL OR (lower(u.name),u.id)>($5,$6::uuid)) ORDER BY lower(u.name),u.id LIMIT 21`,
        [
          org,
          req.user.id,
          ["owner", "admin"].includes(m.role),
          `%${q.q.replace(/[\\%_]/g, "\\$&")}%`,
          q.afterName ?? null,
          q.afterId ?? null,
        ],
      )
    ).rows;
    const people = rows.slice(0, 20),
      last = people.at(-1);
    return {
      people: people.map(({ id, name, email, title }) => ({
        id,
        name,
        email,
        title,
      })),
      nextCursor:
        rows.length > 20 && last
          ? { name: last.cursor_name, id: last.id }
          : null,
    };
  });
  app.post("/v1/organizations/:id/attendee-options/resolve", async (req) => {
    const org = idParam(req),
      m = await member(pool, req.user.id, org),
      b = z
        .object({ ids: z.array(z.uuid()).max(100) })
        .strict()
        .parse(req.body);
    const people = (
      await pool.query(
        `SELECT u.id,u.name,u.email,u.title ${base} AND u.id=ANY($4::uuid[])`,
        [org, req.user.id, ["owner", "admin"].includes(m.role), b.ids],
      )
    ).rows;
    // Contact visibility and invitation eligibility are separate policies. An
    // existing attendee can retain access even when their directory card is hidden.
    const eligible = (
      await pool.query(
        "SELECT u.id FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.org_id=$1 AND m.active AND NOT u.disabled AND u.id=ANY($2::uuid[])",
        [org, b.ids],
      )
    ).rows;
    return {
      people,
      unavailableIds: b.ids.filter((id) => !eligible.some((p) => p.id === id)),
    };
  });
}
