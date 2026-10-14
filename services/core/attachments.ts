import type {DB} from "./db.ts";
import {HttpError} from "./security.ts";
// History must not preserve a deleted file's metadata or imply that a UUID grants access.
export const attachmentProjection = `(SELECT coalesce(json_agg(json_build_object(
  'id',a.file_id,'name',CASE WHEN f.state='ready' THEN f.name ELSE NULL END,
  'state',CASE WHEN f.state='ready' THEN 'ready' ELSE 'unavailable' END)
  ORDER BY a.file_id),'[]') FROM message_attachments a JOIN files f ON f.id=a.file_id
  WHERE a.message_id=m.id AND f.channel_id=m.channel_id AND f.org_id=m.org_id AND NOT m.deleted) attachments`;

export async function attachFiles(db: DB, messageId: string, channelId: string, orgId: string, ids: string[]) {
    for (const id of ids) {
        const file = await db.query("SELECT 1 FROM files WHERE id=$1 AND channel_id=$2 AND org_id=$3 AND state='ready'", [id, channelId, orgId]);
        if (!file.rowCount) throw new HttpError(400, "Attachment unavailable: choose a scanned file in this conversation.");
        await db.query("INSERT INTO message_attachments(message_id,file_id) VALUES($1,$2)", [messageId, id]);
    }
}
