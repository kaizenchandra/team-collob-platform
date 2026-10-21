import type { DB } from "./db.ts";
import { HttpError } from "./security.ts";
// A prepared scheduled call has not necessarily hosted any media yet.
export async function scheduledJoinWindow(db: DB, call: string) {
  const m = (
    await db.query(
      `SELECT m.starts_at,m.ends_at,
 EXISTS(SELECT 1 FROM media_attendance a JOIN media_grants g ON g.id=a.grant_id WHERE g.call_id=$1)
 OR EXISTS(SELECT 1 FROM media_grants g WHERE g.call_id=$1 AND g.revoked_at IS NULL AND g.expires_at>now()) started
 FROM calendar_media cm JOIN meetings m ON m.id=cm.meeting_id WHERE cm.call_id=$1`,
      [call],
    )
  ).rows[0];
  if (!m || m.started) return;
  if (new Date(m.ends_at).getTime() <= Date.now())
    throw new HttpError(409, "This scheduled meeting has ended");
  if (new Date(m.starts_at).getTime() > Date.now() + 15 * 60000)
    throw new HttpError(409, "Joining opens 15 minutes before the meeting");
}
