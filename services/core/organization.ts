import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, transaction, type DB } from "./db.ts";
import { member, HttpError } from "./security.ts";
import { employeeVisibilitySQL } from "./organization-access.ts";
import { idParam } from "./server.ts";
import type {
  OrganizationPerson,
  OrganizationContext,
} from "../../lib/organization.ts";
const query = z
  .object({
    q: z.string().trim().max(160).default(""),
    department: z.string().trim().max(160).default(""),
    roots: z.enum(["true", "false"]).default("false"),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    afterName: z.string().max(1000).optional(),
    afterId: z.uuid().optional(),
  })
  .strict()
  .refine((v) => !!v.afterName === !!v.afterId, "Provide both cursor fields");
const pageQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(20),
    afterName: z.string().max(1000).optional(),
    afterId: z.uuid().optional(),
  })
  .strict()
  .refine((v) => !!v.afterName === !!v.afterId, "Provide both cursor fields");
const base = `SELECT u.id,u.name,u.email,u.title,m.role,
 CASE WHEN p.last_seen<now()-interval '60 seconds' OR p.last_seen IS NULL THEN 'offline' WHEN p.override_until>now() THEN p.state ELSE 'available' END presence,
 coalesce(e.department,'') department,coalesce(e.organizational_unit,'') organizational_unit,coalesce(e.work_location,'') work_location,
 coalesce(e.reporting_status,'unknown') reporting_status,e.manager_id,e.updated_at,e.source_as_of,e.source_label,e.revision::text,
 (SELECT count(*)::int FROM organization_people r JOIN memberships cm ON cm.org_id=r.org_id AND cm.user_id=r.user_id JOIN users cu ON cu.id=r.user_id
 WHERE r.org_id=$1 AND r.manager_id=u.id AND r.reporting_status='assigned' AND cm.active AND NOT cu.disabled AND (r.visibility='workspace' OR r.user_id=$2 OR $3::boolean)) direct_report_count,
 lower(u.name) cursor_name
 FROM memberships m JOIN users u ON u.id=m.user_id LEFT JOIN organization_people e ON e.org_id=m.org_id AND e.user_id=m.user_id LEFT JOIN presence p ON p.org_id=m.org_id AND p.user_id=u.id
 WHERE m.org_id=$1 AND m.active AND NOT u.disabled AND ${employeeVisibilitySQL}`;
type Row = {
  id: string;
  name: string;
  email: string;
  title: string;
  role: string;
  presence: string;
  department: string;
  organizational_unit: string;
  work_location: string;
  reporting_status: OrganizationPerson["reportingStatus"];
  manager_id: string | null;
  updated_at: Date | null;
  source_as_of: Date | null;
  source_label: string | null;
  revision: string | null;
  direct_report_count: number;
  cursor_name: string;
};
function publicPerson(r: Row): OrganizationPerson {
  return {
    id: r.id,
    name: r.name,
    email: r.email,
    title: r.title,
    role: r.role,
    presence: r.presence,
    department: r.department,
    organizationalUnit: r.organizational_unit,
    workLocation: r.work_location,
    reportingStatus: r.reporting_status,
    directReportCount: r.direct_report_count,
    updatedAt: r.updated_at?.toISOString() ?? null,
    sourceAsOf: r.source_as_of?.toISOString() ?? null,
    sourceLabel: r.source_label,
    revision: r.revision,
  };
}
async function actor(db: DB, org: string, user: string) {
  const m = await member(db, user, org);
  return [org, user, ["owner", "admin"].includes(m.role)];
}
async function person(db: DB, params: unknown[], id: string) {
  return (await db.query<Row>(`${base} AND u.id=$4`, [...params, id])).rows[0];
}
function result(rows: Row[], limit: number) {
  const list = rows.slice(0, limit),
    last = list.at(-1);
  return {
    people: list.map(publicPerson),
    nextCursor:
      rows.length > limit && last
        ? { name: last.cursor_name, id: last.id }
        : null,
  };
}
async function profile(db: DB, params: unknown[], id: string) {
  const r = await person(db, params, id);
  if (!r)
    throw new HttpError(
      404,
      "Employee profile is unavailable or restricted in this workspace",
    );
  const manager = r.manager_id ? await person(db, params, r.manager_id) : null;
  return {
    row: r,
    person: publicPerson(r),
    manager: manager ? publicPerson(manager) : null,
    managerState:
      r.reporting_status === "assigned"
        ? ((manager ? "assigned" : "unavailable") as "assigned" | "unavailable")
        : r.reporting_status,
  };
}
export async function registerOrganization(app: FastifyInstance) {
  app.get("/v1/organizations/:id/organization/people", async (req) =>
    transaction(async (db) => {
      await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      const params = await actor(db, idParam(req), req.user.id),
        q = query.parse(req.query),
        needle = `%${q.q.replace(/[\\%_]/g, "\\$&")}%`;
      const rows = (
        await db.query<Row>(
          `${base} AND ($4='' OR u.name ILIKE $5 OR u.title ILIKE $5 OR e.department ILIKE $5 OR e.organizational_unit ILIKE $5 OR u.email ILIKE $5) AND ($6='' OR e.department=$6) AND (NOT $7::boolean OR e.reporting_status='root') AND ($8::text IS NULL OR (lower(u.name),u.id)>($8,$9::uuid)) ORDER BY lower(u.name),u.id LIMIT $10`,
          [
            ...params,
            q.q,
            needle,
            q.department,
            q.roots === "true",
            q.afterName ?? null,
            q.afterId ?? null,
            q.limit + 1,
          ],
        )
      ).rows;
      return result(rows, q.limit);
    }),
  );
  app.get("/v1/organizations/:id/organization/departments", async (req) => {
    const params = await actor(pool, idParam(req), req.user.id);
    return {
      departments: (
        await pool.query(
          `SELECT DISTINCT e.department FROM memberships m JOIN users u ON u.id=m.user_id JOIN organization_people e ON e.org_id=m.org_id AND e.user_id=m.user_id WHERE m.org_id=$1 AND m.active AND NOT u.disabled AND e.department<>'' AND ${employeeVisibilitySQL} ORDER BY e.department LIMIT 100`,
          params,
        )
      ).rows.map((r) => r.department),
    };
  });
  app.get(
    "/v1/organizations/:id/organization/people/:person/profile",
    async (req) =>
      transaction(async (db) => {
        await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
        const params = await actor(db, idParam(req), req.user.id),
          p = await profile(db, params, idParam(req, "person"));
        return {
          person: p.person,
          manager: p.manager,
          managerState: p.managerState,
        };
      }),
  );
  app.get("/v1/organizations/:id/organization/people/:person", async (req) =>
    transaction(async (db) => {
      await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      const params = await actor(db, idParam(req), req.user.id),
        p = await profile(db, params, idParam(req, "person")),
        chain: OrganizationPerson[] = [];
      const seen = new Set([p.person.id]);
      let current = p.row,
        status: OrganizationContext["chainStatus"] = "complete";
      for (let depth = 0; depth < 20; depth++) {
        if (current.reporting_status !== "assigned") {
          status = current.reporting_status === "root" ? "complete" : "unknown";
          break;
        }
        const id = current.manager_id!;
        if (seen.has(id)) {
          status = "cycle";
          break;
        }
        seen.add(id);
        const next = await person(db, params, id);
        if (!next) {
          status = "unavailable";
          break;
        }
        chain.push(publicPerson(next));
        current = next;
        if (depth === 19)
          status =
            current.reporting_status === "assigned"
              ? "truncated"
              : current.reporting_status === "root"
                ? "complete"
                : "unknown";
      }
      return {
        person: p.person,
        manager: p.manager,
        managerState: p.managerState,
        chain: chain.reverse(),
        chainStatus: status,
        loadedAt: new Date().toISOString(),
      } satisfies OrganizationContext;
    }),
  );
  for (const kind of ["reports", "peers"] as const)
    app.get(
      `/v1/organizations/:id/organization/people/:person/${kind}`,
      async (req) =>
        transaction(async (db) => {
          await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
          const params = await actor(db, idParam(req), req.user.id),
            p = await profile(db, params, idParam(req, "person")),
            q = pageQuery.parse(req.query);
          if (kind === "peers" && p.managerState !== "assigned")
            return {
              people: [],
              nextCursor: null,
              unavailable: p.managerState === "unavailable",
            };
          const parent = kind === "reports" ? p.person.id : p.row.manager_id;
          const rows = (
            await db.query<Row>(
              `${base} AND e.reporting_status='assigned' AND e.manager_id=$4 AND ($5::uuid IS NULL OR u.id<>$5) AND ($6::text IS NULL OR (lower(u.name),u.id)>($6,$7::uuid)) ORDER BY lower(u.name),u.id LIMIT $8`,
              [
                ...params,
                parent,
                kind === "peers" ? p.person.id : null,
                q.afterName ?? null,
                q.afterId ?? null,
                q.limit + 1,
              ],
            )
          ).rows;
          return result(rows, q.limit);
        }),
    );
}
