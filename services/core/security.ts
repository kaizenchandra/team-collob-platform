import {createHash, randomBytes, scryptSync, timingSafeEqual,} from "node:crypto";
import type {DB} from "./db.ts";

export class HttpError extends Error {
    statusCode: number;

    constructor(code: number, message: string) {
        super(message);
        this.statusCode = code;
    }
}

export const hash = (s: string) => createHash("sha256").update(s).digest("hex");

export function passwordHash(password: string) {
    const salt = randomBytes(16).toString("hex");
    return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}

export function passwordMatches(password: string, encoded: string) {
    const [salt, key] = encoded.split(":");
    const actual = scryptSync(password, salt, 64);
    return timingSafeEqual(actual, Buffer.from(key, "hex"));
}

export const accessSQL = `(EXISTS(SELECT 1 FROM memberships om WHERE om.org_id=c.org_id AND om.user_id=$1 AND om.active) AND (c.kind='standard' AND EXISTS(SELECT 1 FROM team_members tm WHERE tm.team_id=c.team_id AND tm.user_id=$1) OR c.kind<>'standard' AND EXISTS(SELECT 1 FROM channel_members cm WHERE cm.channel_id=c.id AND cm.user_id=$1)))`;

export async function member(db: DB, user: string, org: string, admin = false) {
    const r = await db.query(
        "SELECT role FROM memberships WHERE org_id=$1 AND user_id=$2 AND active",
        [org, user],
    );
    if (!r.rowCount) throw new HttpError(404, "Workspace unavailable");
    if (admin && !["owner", "admin"].includes(r.rows[0].role))
        throw new HttpError(403, "Administrator role required");
    return r.rows[0];
}

export async function channel(db: DB, user: string, id: string, lock = false) {
    const r = await db.query(
        `SELECT c.* FROM channels c WHERE c.id=$2 AND ${accessSQL} ${lock ? "FOR UPDATE OF c" : ""}`,
        [user, id],
    );
    if (!r.rowCount) throw new HttpError(404, "Conversation unavailable");
    return r.rows[0];
}

export async function audit(
    db: DB,
    user: string,
    org: string,
    action: string,
    target: string,
    metadata: unknown = {},
) {
    await db.query(
        "INSERT INTO audit(org_id,actor_id,action,target,metadata) VALUES($1,$2,$3,$4,$5)",
        [org, user, action, target, JSON.stringify(metadata)],
    );
}

export async function event(
    db: DB,
    org: string,
    stream: string,
    type: string,
    payload: unknown = {},
) {
    await db.query(
        "INSERT INTO outbox(org_id,channel_id,type,payload) VALUES($1,$2,$3,$4)",
        [org, stream, type, JSON.stringify(payload)],
    );
}
