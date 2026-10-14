import {unified} from "unified";
import remarkParse from "remark-parse";
import {z} from "zod";
import {type DB} from "./db.ts";
import {accessSQL, HttpError} from "./security.ts";

const parser = unified().use(remarkParse);
export const mentionProjection = `(SELECT coalesce(json_agg(json_build_object('id',mu.id,'name',mu.name) ORDER BY mu.id),'[]') FROM message_mentions mm JOIN users mu ON mu.id=mm.user_id WHERE mm.message_id=m.id) mentions`;

export function mentionRecipients(body: string, format: string): string[] {
    if (format !== "markdown-v1") return [];
    const recipients = new Set<string>();
    const pending: { type: string; url?: string; children?: unknown[] }[] = [parser.parse(body)];
    while (pending.length) {
        const node = pending.pop()!;
        if (node.type === "link" && node.url?.startsWith("concord-mention:")) {
            const value = z.uuid().safeParse(node.url.slice("concord-mention:".length));
            if (!value.success) throw new HttpError(400, "Invalid mention. Select a channel member again.");
            recipients.add(value.data.toLowerCase());
            if (recipients.size > 20) throw new HttpError(400, "Mention at most 20 people per message.");
        }
        if (node.children) pending.push(...node.children as typeof pending);
    }
    return [...recipients].sort();
}

export async function replaceMentions(db: DB, messageId: string, channelId: string, recipients: string[]) {
    for (const userId of recipients) {
        const eligible = await db.query(`SELECT 1 FROM channels c JOIN users u ON u.id=$1 AND NOT u.disabled WHERE c.id=$2 AND ${accessSQL}`, [userId, channelId]);
        if (!eligible.rowCount) throw new HttpError(400, "A mentioned person cannot access this conversation. Remove the mention or select an eligible member.");
    }
    await db.query("DELETE FROM message_mentions WHERE message_id=$1", [messageId]);
    if (recipients.length) await db.query("INSERT INTO message_mentions(message_id,user_id) SELECT $1,unnest($2::uuid[])", [messageId, recipients]);
}
