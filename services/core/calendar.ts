import { scheduledJoinWindow } from "./calendar-media.ts";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Temporal } from "@js-temporal/polyfill";
import { pool, transaction } from "./db.ts";
import { member, HttpError, audit } from "./security.ts";
import { idParam } from "./server.ts";
import { meetingLimits, mediaConfiguration } from "./media-config.ts";
import {
  calendarDate,
  withinWorkingHours,
  type WorkDay,
} from "../../lib/calendar.ts";
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => {
    try {
      Temporal.PlainDate.from(s);
      return true;
    } catch {
      return false;
    }
  }, "Invalid date");
const zone = z
  .string()
  .max(100)
  .refine((s) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: s });
      return true;
    } catch {
      return false;
    }
  }, "Invalid timezone");
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const schedule = z
  .object({
    timezone: zone,
    days: z
      .array(
        z
          .object({
            day: z.number().int().min(1).max(7),
            start: time,
            end: time,
          })
          .strict(),
      )
      .max(7)
      .refine(
        (a) => new Set(a.map((x) => x.day)).size === a.length,
        "Use one shift per day",
      ),
    holidayCalendar: z.string().trim().min(1).max(100),
  })
  .strict();
const range = z
  .object({ from: z.iso.datetime(), to: z.iso.datetime() })
  .strict()
  .refine(
    (b) =>
      Date.parse(b.to) > Date.parse(b.from) &&
      Date.parse(b.to) - Date.parse(b.from) <= 367 * 86400000,
    "Range must be positive and at most 367 days",
  );
async function meeting(org: string, user: string, id: string) {
  await member(pool, user, org);
  const m = (
    await pool.query(
      "SELECT * FROM meetings m WHERE m.org_id=$1 AND m.id=$2 AND (m.organizer_id=$3 OR EXISTS(SELECT 1 FROM meeting_attendees a WHERE a.meeting_id=m.id AND a.user_id=$3))",
      [org, id, user],
    )
  ).rows[0];
  if (!m) throw new HttpError(404, "Meeting unavailable");
  return m;
}
export async function registerCalendar(app: FastifyInstance) {
  app.get("/v1/organizations/:id/calendar/teams/:team", async (req) => {
    const org = idParam(req),
      team = idParam(req, "team");
    await member(pool, req.user.id, org);
    if (
      !(
        await pool.query(
          "SELECT 1 FROM teams t JOIN team_members tm ON tm.team_id=t.id WHERE t.org_id=$1 AND t.id=$2 AND tm.user_id=$3 AND NOT t.archived",
          [org, team, req.user.id],
        )
      ).rowCount
    )
      throw new HttpError(404, "Team unavailable");
    return {
      members: (
        await pool.query(
          "SELECT u.id,u.name FROM team_members tm JOIN memberships m ON m.org_id=tm.org_id AND m.user_id=tm.user_id JOIN users u ON u.id=tm.user_id WHERE tm.team_id=$1 AND m.active AND NOT u.disabled ORDER BY u.name,u.id LIMIT 101",
          [team],
        )
      ).rows,
    };
  });
  app.get("/v1/organizations/:id/calendar/settings", async (req) => {
    const org = idParam(req),
      actor = await member(pool, req.user.id, org);
    const settings =
      (
        await pool.query(
          "SELECT timezone,days,holiday_calendar FROM calendar_schedules WHERE org_id=$1 AND user_id=$2",
          [org, req.user.id],
        )
      ).rows[0] ?? null;
    const calendars = (
      await pool.query(
        "SELECT DISTINCT calendar FROM calendar_holidays WHERE org_id=$1 ORDER BY calendar",
        [org],
      )
    ).rows.map((x) => x.calendar);
    return {
      settings,
      calendars,
      canManage: ["owner", "admin"].includes(actor.role),
    };
  });
  app.put("/v1/organizations/:id/calendar/settings", async (req) => {
    const org = idParam(req);
    await member(pool, req.user.id, org);
    const b = schedule.parse(req.body);
    await pool.query(
      "INSERT INTO calendar_schedules(org_id,user_id,timezone,days,holiday_calendar) VALUES($1,$2,$3,$4,$5) ON CONFLICT(org_id,user_id) DO UPDATE SET timezone=excluded.timezone,days=excluded.days,holiday_calendar=excluded.holiday_calendar,updated_at=now()",
      [org, req.user.id, b.timezone, JSON.stringify(b.days), b.holidayCalendar],
    );
    return { ok: true };
  });
  app.get("/v1/organizations/:id/calendar/blocks", async (req) => {
    const org = idParam(req);
    await member(pool, req.user.id, org);
    const q = range.parse(req.query);
    const own = (
      await pool.query(
        "SELECT timezone,holiday_calendar FROM calendar_schedules WHERE org_id=$1 AND user_id=$2",
        [org, req.user.id],
      )
    ).rows[0];
    const timezone = own?.timezone ?? req.user.timezone ?? "UTC",
      first = calendarDate(q.from, timezone),
      last = calendarDate(
        Temporal.Instant.from(q.to).subtract({ nanoseconds: 1 }).toString(),
        timezone,
      );
    const holidays = (
      await pool.query(
        "SELECT id,title,to_char(day,'YYYY-MM-DD') AS \"day\",calendar FROM calendar_holidays WHERE org_id=$1 AND calendar=$2 AND day BETWEEN $3::date AND $4::date ORDER BY day,id",
        [org, own?.holiday_calendar ?? "Company", first, last],
      )
    ).rows;
    const leave = (
      await pool.query(
        "SELECT id,status,to_char(first_day,'YYYY-MM-DD') first_day,to_char(last_day,'YYYY-MM-DD') last_day,starts_at,ends_at FROM calendar_leave WHERE org_id=$1 AND user_id=$2 AND status<>'cancelled' AND ((first_day<=$4::date AND last_day>=$3::date) OR (starts_at<$6::timestamptz AND ends_at>$5::timestamptz)) ORDER BY coalesce(starts_at,first_day::timestamptz),id",
        [org, req.user.id, first, last, q.from, q.to],
      )
    ).rows;
    return { holidays, leave };
  });
  app.get("/v1/organizations/:id/calendar/my-leave", async (req) => {
    const org = idParam(req);
    await member(pool, req.user.id, org);
    return {
      leave: (
        await pool.query(
          "SELECT id,status,to_char(first_day,'YYYY-MM-DD') first_day,to_char(last_day,'YYYY-MM-DD') last_day,starts_at,ends_at FROM calendar_leave WHERE org_id=$1 AND user_id=$2 AND status<>'cancelled' ORDER BY created_at DESC LIMIT 100",
          [org, req.user.id],
        )
      ).rows,
    };
  });
  app.get("/v1/organizations/:id/calendar/holidays", async (req) => {
    const org = idParam(req);
    await member(pool, req.user.id, org, true);
    const q = z
      .object({ year: z.coerce.number().int().min(1900).max(9998) })
      .strict()
      .parse(req.query);
    return {
      holidays: (
        await pool.query(
          "SELECT id,title,to_char(day,'YYYY-MM-DD') AS \"day\",calendar FROM calendar_holidays WHERE org_id=$1 AND day>=make_date($2,1,1) AND day<make_date($2+1,1,1) ORDER BY day,calendar,id",
          [org, q.year],
        )
      ).rows,
    };
  });
  app.post("/v1/organizations/:id/calendar/leave", async (req) => {
    const org = idParam(req);
    await member(pool, req.user.id, org);
    const b = z
      .discriminatedUnion("allDay", [
        z
          .object({ allDay: z.literal(true), firstDay: date, lastDay: date })
          .strict()
          .refine((x) => x.lastDay >= x.firstDay),
        z
          .object({
            allDay: z.literal(false),
            startsAt: z.iso.datetime(),
            endsAt: z.iso.datetime(),
          })
          .strict()
          .refine((x) => Date.parse(x.endsAt) > Date.parse(x.startsAt)),
      ])
      .parse(req.body);
    const id = randomUUID();
    await pool.query(
      "INSERT INTO calendar_leave(id,org_id,user_id,first_day,last_day,starts_at,ends_at) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [
        id,
        org,
        req.user.id,
        b.allDay ? b.firstDay : null,
        b.allDay ? b.lastDay : null,
        b.allDay ? null : b.startsAt,
        b.allDay ? null : b.endsAt,
      ],
    );
    return { id, status: "pending" };
  });
  app.get("/v1/organizations/:id/calendar/leave", async (req) => {
    const org = idParam(req);
    await member(pool, req.user.id, org, true);
    return {
      leave: (
        await pool.query(
          "SELECT l.id,u.name,l.user_id,l.status,to_char(first_day,'YYYY-MM-DD') first_day,to_char(last_day,'YYYY-MM-DD') last_day,starts_at,ends_at FROM calendar_leave l JOIN users u ON u.id=l.user_id WHERE l.org_id=$1 AND l.status='pending' ORDER BY created_at LIMIT 100",
          [org],
        )
      ).rows,
    };
  });
  app.patch("/v1/organizations/:id/calendar/leave/:leave", async (req) => {
    const org = idParam(req),
      actor = await member(pool, req.user.id, org),
      b = z
        .object({ status: z.enum(["approved", "cancelled"]) })
        .strict()
        .parse(req.body);
    return transaction(async (db) => {
      const row = (
        await db.query(
          "SELECT * FROM calendar_leave WHERE org_id=$1 AND id=$2 FOR UPDATE",
          [org, idParam(req, "leave")],
        )
      ).rows[0];
      if (!row) throw new HttpError(404, "Leave unavailable");
      if (
        !["owner", "admin"].includes(actor.role) &&
        (row.user_id !== req.user.id || b.status !== "cancelled")
      )
        throw new HttpError(403, "Only administrators can approve leave");
      if (row.status === "cancelled" && b.status !== "cancelled")
        throw new HttpError(409, "Cancelled leave cannot be approved");
      await db.query(
        "UPDATE calendar_leave SET status=$2,reviewed_by=$3 WHERE id=$1",
        [row.id, b.status, req.user.id],
      );
      await audit(db, req.user.id, org, `calendar.leave.${b.status}`, row.id);
      return { ok: true };
    });
  });
  app.post("/v1/organizations/:id/calendar/holidays", async (req) => {
    const org = idParam(req);
    await member(pool, req.user.id, org, true);
    const b = z
      .object({
        title: z.string().trim().min(1).max(200),
        day: date,
        calendar: z.string().trim().min(1).max(100),
      })
      .strict()
      .parse(req.body);
    const id = randomUUID();
    await pool.query(
      "INSERT INTO calendar_holidays(id,org_id,title,day,calendar,created_by) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(org_id,calendar,day,title) DO NOTHING",
      [id, org, b.title, b.day, b.calendar, req.user.id],
    );
    return { ok: true };
  });
  app.delete(
    "/v1/organizations/:id/calendar/holidays/:holiday",
    async (req) => {
      const org = idParam(req);
      await member(pool, req.user.id, org, true);
      await pool.query(
        "DELETE FROM calendar_holidays WHERE org_id=$1 AND id=$2",
        [org, idParam(req, "holiday")],
      );
      return { ok: true };
    },
  );
  app.post("/v1/organizations/:id/calendar/availability", async (req) => {
    const org = idParam(req);
    await member(pool, req.user.id, org);
    const b = z
      .object({
        startsAt: z.iso.datetime(),
        endsAt: z.iso.datetime(),
        userIds: z.array(z.uuid()).min(1).max(100),
        excludeMeeting: z.uuid().optional(),
      })
      .strict()
      .parse(req.body);
    range.parse({ from: b.startsAt, to: b.endsAt });
    if (b.excludeMeeting) {
      const excluded = await meeting(org, req.user.id, b.excludeMeeting);
      if (excluded.organizer_id !== req.user.id)
        throw new HttpError(
          403,
          "Only the organizer can exclude a meeting while editing",
        );
    }
    const result = [];
    for (const user of [...new Set(b.userIds)]) {
      const eligible = (
        await pool.query(
          "SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.org_id=$1 AND m.user_id=$2 AND m.active AND NOT u.disabled",
          [org, user],
        )
      ).rowCount;
      if (!eligible) {
        result.push({
          userId: user,
          status: "unknown",
          reasons: ["Availability unavailable"],
        });
        continue;
      }
      const s = (
        await pool.query(
          "SELECT * FROM calendar_schedules WHERE org_id=$1 AND user_id=$2",
          [org, user],
        )
      ).rows[0];
      const timezone = s?.timezone ?? "UTC",
        first = calendarDate(b.startsAt, timezone),
        last = calendarDate(
          Temporal.Instant.from(b.endsAt)
            .subtract({ nanoseconds: 1 })
            .toString(),
          timezone,
        );
      const busy = (
        await pool.query(
          "SELECT 1 FROM meetings m JOIN meeting_attendees a ON a.meeting_id=m.id WHERE m.org_id=$1 AND a.user_id=$2 AND a.response<>'declined' AND NOT m.cancelled AND m.ends_at>$3 AND m.starts_at<$4 AND ($5::uuid IS NULL OR m.id<>$5) LIMIT 1",
          [org, user, b.startsAt, b.endsAt, b.excludeMeeting ?? null],
        )
      ).rowCount;
      const leave = (
        await pool.query(
          "SELECT 1 FROM calendar_leave WHERE org_id=$1 AND user_id=$2 AND status='approved' AND ((first_day<=$4::date AND last_day>=$3::date) OR (starts_at<$6 AND ends_at>$5)) LIMIT 1",
          [org, user, first, last, b.startsAt, b.endsAt],
        )
      ).rowCount;
      const holiday = (
        await pool.query(
          "SELECT 1 FROM calendar_holidays WHERE org_id=$1 AND calendar=$2 AND day BETWEEN $3::date AND $4::date LIMIT 1",
          [org, s?.holiday_calendar ?? "Company", first, last],
        )
      ).rowCount;
      const reasons = [
        ...(busy ? ["Busy"] : []),
        ...(leave ? ["Unavailable"] : []),
        ...(holiday ? ["Holiday"] : []),
        ...(s &&
        !withinWorkingHours(
          b.startsAt,
          b.endsAt,
          s.timezone,
          s.days as WorkDay[],
        )
          ? ["Outside working hours"]
          : []),
        ...(!s ? ["Working hours unknown"] : []),
      ];
      result.push({
        userId: user,
        status:
          busy || leave || holiday || reasons.includes("Outside working hours")
            ? "conflict"
            : !s
              ? "unknown"
              : "available",
        reasons,
      });
    }
    return { availability: result };
  });
  app.get("/v1/organizations/:id/meetings/:meeting/details", async (req) => {
    const org = idParam(req),
      m = await meeting(org, req.user.id, idParam(req, "meeting"));
    const participants = (
      await pool.query(
        "SELECT u.id,u.name,coalesce(a.response,'accepted') response FROM users u LEFT JOIN meeting_attendees a ON a.user_id=u.id AND a.meeting_id=$1 WHERE a.meeting_id=$1 OR u.id=$2 ORDER BY u.name,u.id",
        [m.id, m.organizer_id],
      )
    ).rows;
    const call =
      (
        await pool.query(
          "SELECT x.id,x.channel_id,x.ended_at,(EXISTS(SELECT 1 FROM media_attendance a JOIN media_grants g ON g.id=a.grant_id WHERE g.call_id=x.id) OR EXISTS(SELECT 1 FROM media_grants g WHERE g.call_id=x.id AND g.revoked_at IS NULL AND g.expires_at>now())) started FROM calendar_media cm JOIN media_calls x ON x.id=cm.call_id WHERE cm.meeting_id=$1",
          [m.id],
        )
      ).rows[0] ?? null;
    return { meeting: m, participants, call };
  });
  app.post("/v1/organizations/:id/meetings/:meeting/call", async (req) => {
    const org = idParam(req),
      m = await meeting(org, req.user.id, idParam(req, "meeting"));
    if (!mediaConfiguration())
      throw new HttpError(503, "LiveKit is not configured");
    return transaction(async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(712399)");
      const locked = (
        await db.query("SELECT * FROM meetings WHERE id=$1 FOR UPDATE", [m.id])
      ).rows[0];
      if (locked.cancelled)
        throw new HttpError(409, "This meeting is cancelled");
      if (locked.meeting_type === "in_person")
        throw new HttpError(409, "This is an in-person meeting");
      if (
        !(
          await db.query(
            "SELECT 1 FROM meeting_attendees WHERE meeting_id=$1 AND user_id=$2",
            [m.id, req.user.id],
          )
        ).rowCount &&
        locked.organizer_id !== req.user.id
      )
        throw new HttpError(404, "Meeting unavailable");
      const old = (
        await db.query(
          "SELECT x.* FROM calendar_media cm JOIN media_calls x ON x.id=cm.call_id WHERE cm.meeting_id=$1",
          [m.id],
        )
      ).rows[0];
      if (old?.ended_at) throw new HttpError(409, "This meeting has ended");
      if (old) await scheduledJoinWindow(db, old.id);
      if (!old && Date.parse(locked.ends_at) <= Date.now())
        throw new HttpError(409, "This scheduled meeting has ended");
      if (!old && Date.parse(locked.starts_at) > Date.now() + 15 * 60000)
        throw new HttpError(409, "Joining opens 15 minutes before the meeting");
      const busy = (
        await db.query(
          "SELECT g.call_id FROM media_grants g JOIN media_calls x ON x.id=g.call_id WHERE g.user_id=$1 AND g.revoked_at IS NULL AND g.expires_at>now() AND x.ended_at IS NULL LIMIT 1",
          [req.user.id],
        )
      ).rows[0];
      if (busy && busy.call_id !== old?.id)
        throw new HttpError(
          409,
          "Leave your current call before joining another meeting",
        );
      if (old) return { id: old.id, channelId: old.channel_id, mode: old.mode };
      if (
        Number(
          (
            await db.query(
              "SELECT count(*) FROM media_calls WHERE ended_at IS NULL",
            )
          ).rows[0].count,
        ) >= meetingLimits().calls
      )
        throw new HttpError(409, "Deployment call limit reached");
      const users = (
        await db.query(
          "SELECT a.user_id FROM meeting_attendees a JOIN memberships om ON om.org_id=$2 AND om.user_id=a.user_id AND om.active JOIN users u ON u.id=a.user_id AND NOT u.disabled WHERE a.meeting_id=$1",
          [m.id, org],
        )
      ).rows.map((x) => x.user_id);
      if (!users.includes(locked.organizer_id)) {
        if (
          !(
            await db.query(
              "SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.org_id=$1 AND m.user_id=$2 AND m.active AND NOT u.disabled",
              [org, locked.organizer_id],
            )
          ).rowCount
        )
          throw new HttpError(
            409,
            "The organizer is unavailable; ask an active organizer to schedule a new meeting",
          );
        users.push(locked.organizer_id);
      }
      if (users.length > meetingLimits().invitations)
        throw new HttpError(409, "Meeting participant limit exceeded");
      const channel = randomUUID(),
        id = randomUUID();
      await db.query(
        "INSERT INTO channels(id,org_id,name,kind) VALUES($1,$2,$3,'group')",
        [channel, org, locked.title],
      );
      for (const user of users)
        await db.query("INSERT INTO channel_members VALUES($1,$2,$3)", [
          org,
          channel,
          user,
        ]);
      await db.query(
        "INSERT INTO media_calls(id,org_id,channel_id,host_user_id,caller_user_id,client_id,mode,instant,ring_until) VALUES($1,$2,$3,$4,$4,$5,$6,true,now())",
        [id, org, channel, locked.organizer_id, m.id, locked.meeting_type],
      );
      await db.query(
        "INSERT INTO media_rooms(id,call_id,name,client_id,is_main) VALUES($1,$1,'Main room',$1,true)",
        [id],
      );
      for (const user of users)
        await db.query(
          "INSERT INTO media_invitations(call_id,user_id,response) VALUES($1,$2,'accepted')",
          [id, user],
        );
      await db.query("INSERT INTO calendar_media VALUES($1,$2)", [m.id, id]);
      await audit(db, req.user.id, org, "calendar.call.created", m.id);
      return { id, channelId: channel, mode: locked.meeting_type };
    });
  });
}
