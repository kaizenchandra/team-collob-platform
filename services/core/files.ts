import {requireUnheld} from './preservation.ts';
import type {FastifyInstance} from "fastify";
import {z} from "zod";
import {createHash, randomUUID} from "node:crypto";
import {mkdir, open} from "node:fs/promises";
import path from "node:path";
import {pool, transaction} from "./db.ts";
import {accessSQL, audit, channel, event, HttpError} from "./security.ts";
import {idParam} from "./server.ts";
import {storedBytes, validateFile} from "./file-content.ts";
import {filePreviewSchema, previewLimit, previewMimeTypes} from "../../lib/file-preview.ts";

async function readableFile(user: string, id: string, file: string, preview = false) {
    await channel(pool, user, id);
    const row = (await pool.query("SELECT * FROM files WHERE id=$1 AND channel_id=$2 AND state<>'deleted'", [file, id])).rows[0];
    if (!row) throw new HttpError(404, "File unavailable");
    if (row.state !== "ready") throw new HttpError(409, "File unavailable: the file has not passed malware scanning.");
    if (preview && !previewMimeTypes.includes(row.mime)) throw new HttpError(415, "Preview unavailable for this format. Download the scanned file to open it.");
    let bytes: Buffer;
    try {
        bytes = await storedBytes(row);
    } catch {
        throw new HttpError(503, "File integrity could not be verified. Contact your administrator.");
    }
    // One authoritative post-I/O query rechecks both access and current state.
    const allowed = await pool.query(`SELECT 1 FROM files f JOIN channels c ON c.id=f.channel_id WHERE f.id=$3 AND c.id=$2 AND f.state='ready' AND ${accessSQL}`, [user, id, file]);
    if (!allowed.rowCount) throw new HttpError(404, "File unavailable");
    return {row, bytes};
}

export async function registerFiles(app: FastifyInstance) {
    const root = path.resolve(process.env.FILE_ROOT ?? ".data/files");
    app.get("/v1/channels/:id/deleted-files", async req => {
        const id = idParam(req);
        await channel(pool, req.user.id, id);
        const q = z.object({beforeCreated: z.iso.datetime().refine(v=>!v.startsWith("0000-"),"Invalid cursor year").optional(), beforeId: z.uuid().optional()}).strict().parse(req.query);
        if (!!q.beforeCreated !== !!q.beforeId) throw new HttpError(400, "Provide both deleted-file cursor fields");
        const rows = (await pool.query(`SELECT f.id,f.name,f.bytes,f.revision_root,f.revision_number,f.lifecycle_revision,
          to_char(f.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') cursor_created
          FROM files f JOIN channels c ON c.id=f.channel_id
          WHERE f.channel_id=$2 AND f.created_by=$1 AND f.state='deleted' AND ${accessSQL}
          AND ($3::timestamptz IS NULL OR (f.created_at,f.id)<($3,$4::uuid))
          ORDER BY f.created_at DESC,f.id DESC LIMIT 101`, [req.user.id,id,q.beforeCreated??null,q.beforeId??null])).rows;
        const page=rows.slice(0,100),last=page.at(-1),hasMore=rows.length>100;
        return {files: page.map(row=>{const {cursor_created,...file}=row;void cursor_created;return file;}),hasMore,nextCursor:hasMore?{createdAt:last.cursor_created,id:last.id}:null};
    });
    app.post("/v1/channels/:id/files/:file/restore", async req => {
        const id = idParam(req), file = idParam(req, "file");
        const b = z.object({expectedRevision: z.number().int().positive(), confirm: z.literal(true)}).strict().parse(req.body);
        return transaction(async db => {
            await channel(db, req.user.id, id, true);
            const c = await channel(db, req.user.id, id);
            const row = (await db.query("SELECT * FROM files WHERE id=$1 AND channel_id=$2 AND created_by=$3", [file, id, req.user.id])).rows[0];
            if (!row) throw new HttpError(404, "Only the uploader can restore this file");
            if (c.archived) throw new HttpError(409, "Restore the channel before recovering files");
            if (row.state !== "deleted" || row.lifecycle_revision !== b.expectedRevision) throw new HttpError(409, "File changed. Refresh deleted files before restoring");
            if (row.revision_root && !(await db.query("SELECT 1 FROM files WHERE id=$1 AND state<>'deleted'", [row.revision_root])).rowCount) throw new HttpError(409, "Restore the original before this version");
            await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [c.org_id]);
            const usage = (await db.query("SELECT coalesce(sum(bytes),0)::bigint bytes FROM files WHERE org_id=$1 AND state<>'deleted'", [c.org_id])).rows[0];
            if (Number(usage.bytes) + Number(row.bytes) > 104857600) throw new HttpError(413, "Workspace development quota exceeded (100 MB)");
            await db.query("UPDATE files SET state='quarantined',lifecycle_revision=lifecycle_revision+1 WHERE id=$1", [file]);
            await db.query("INSERT INTO file_scan_jobs(file_id) VALUES($1) ON CONFLICT(file_id) DO UPDATE SET status='queued',attempts=0,available_at=now(),lease_id=NULL,lease_until=NULL,last_error=NULL,scanned_at=NULL,scanner_version=NULL", [file]);
            await audit(db, req.user.id, c.org_id, "file.restore_requested", file, {revision: b.expectedRevision + 1});
            await event(db, c.org_id, id, "file.uploaded");
            return {ok: true, state: "quarantined"};
        });
    });
    app.get("/v1/channels/:id/files", async (req) => {
        const id = idParam(req);
        await channel(pool, req.user.id, id);
        const q = z.object({beforeCreated:z.iso.datetime().refine(v=>!v.startsWith("0000-"),"Invalid cursor year").optional(),beforeId:z.uuid().optional()}).strict().parse(req.query);
        if (!!q.beforeCreated !== !!q.beforeId) throw new HttpError(400,"Provide both file cursor fields");
        const rows=(await pool.query(`SELECT f.id,f.name,f.mime,f.bytes,f.state,f.created_at,f.created_by,f.revision_number,j.status scan_status,j.attempts,
          to_char(f.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') cursor_created
          FROM files f JOIN channels c ON c.id=f.channel_id LEFT JOIN file_scan_jobs j ON j.file_id=f.id
          WHERE f.channel_id=$2 AND f.revision_root IS NULL AND f.state<>'deleted' AND ${accessSQL}
          AND ($3::timestamptz IS NULL OR (f.created_at,f.id)<($3,$4::uuid))
          ORDER BY f.created_at DESC,f.id DESC LIMIT 101`,[req.user.id,id,q.beforeCreated??null,q.beforeId??null])).rows;
        const page=rows.slice(0,100),last=page.at(-1),hasMore=rows.length>100;
        return {files:page.map(row=>{const {cursor_created,...file}=row;void cursor_created;return file;}),hasMore,nextCursor:hasMore?{createdAt:last.cursor_created,id:last.id}:null};
    });
    app.get("/v1/channels/:id/files/:file/versions", async (req) => {
        const id = idParam(req), file = idParam(req, "file");
        return transaction(async db => {
            await channel(db, req.user.id, id, true);
            const root = (await db.query("SELECT id,created_by FROM files WHERE id=$1 AND channel_id=$2 AND revision_root IS NULL AND state<>'deleted'", [file, id])).rows[0];
            if (!root) throw new HttpError(404, "File unavailable");
            const versions = (await db.query("SELECT f.id,f.name,f.mime,f.bytes,f.state,f.revision_number,f.created_at,j.status scan_status FROM files f LEFT JOIN file_scan_jobs j ON j.file_id=f.id WHERE (f.id=$1 OR f.revision_root=$1) AND f.state<>'deleted' ORDER BY f.revision_number DESC LIMIT 100", [file])).rows;
            return {canUpload: root.created_by === req.user.id, versions};
        });
    });
    app.post("/v1/channels/:id/files", {bodyLimit: 1500000}, async (req) => {
        const id = idParam(req);
        const b = z
            .object({
                versionOf: z.uuid().transform(v => v.toLowerCase()).optional(),
                clientId: z.uuid().transform(v => v.toLowerCase()).optional(),
                name: z
                    .string()
                    .min(1)
                    .max(200)
                    .regex(/^[^/\\\x00-\x1f]+$/),
                mime: z.string().max(120),
                content: z
                    .string()
                    .max(1400000)
                    .regex(/^[A-Za-z0-9+/]*={0,2}$/),
            })
            .parse(req.body);
        await channel(pool, req.user.id, id);
        const bytes = Buffer.from(b.content, "base64");
        if (bytes.length > 1048576)
            throw new HttpError(413, "Maximum upload size is 1 MB");
        const mime = validateFile(b.name, b.mime, bytes);
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        return transaction(async db => {
            const c = await channel(db, req.user.id, id, true);
            if (b.clientId) {
                const old = (await db.query("SELECT * FROM files WHERE channel_id=$1 AND created_by=$2 AND client_id=$3", [id, req.user.id, b.clientId])).rows[0];
                if (old) {
                    if (old.revision_root !== (b.versionOf ?? null) || old.name !== b.name || old.mime !== mime || Number(old.bytes) !== bytes.length || old.sha256 !== sha256) throw new HttpError(409, "Upload ID already used with different content");
                    return {id: old.id, state: old.state};
                }
            }
            let revisionNumber = 1;
            if (b.versionOf) {
                const parent = (await db.query("SELECT * FROM files WHERE id=$1 AND channel_id=$2 AND revision_root IS NULL AND state='ready' AND created_by=$3", [b.versionOf, id, req.user.id])).rows[0];
                if (!parent) throw new HttpError(404, "Only the uploader of an available scanned original can add versions");
                if (parent.name !== b.name || parent.mime !== mime) throw new HttpError(400, "Versions must retain the original filename and format");
                revisionNumber = Number((await db.query("SELECT max(revision_number) n FROM files WHERE id=$1 OR revision_root=$1", [b.versionOf])).rows[0].n) + 1;
                if (revisionNumber > 100) throw new HttpError(409, "This file has reached the 100-version limit");
            }
            await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [c.org_id]);
            const usage = await db.query("SELECT coalesce(sum(bytes),0)::bigint bytes FROM files WHERE org_id=$1 AND state<>'deleted'", [c.org_id]);
            if (Number(usage.rows[0].bytes) + bytes.length > 104857600) throw new HttpError(413, "Workspace development quota exceeded (100 MB)");
            // Shared with reconciliation: metadata absence is meaningful only outside an active write.
            await db.query("SELECT pg_advisory_xact_lock_shared(712341)");
            const file = randomUUID();
            await mkdir(root, {recursive: true, mode: 0o700});
            const handle = await open(path.join(root, file), "wx", 0o600);
            try {
                await handle.writeFile(bytes);
                await handle.sync();
            } finally {
                await handle.close();
            }
            const directory = await open(root, "r");
            try {
                await directory.sync();
            } finally {
                await directory.close();
            }
            // On any failure retain bytes for reconciliation, including ambiguous COMMIT failures.
            await db.query("INSERT INTO files(id,org_id,channel_id,name,mime,bytes,storage_key,sha256,created_by,client_id,revision_root,revision_number) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)", [file, c.org_id, id, b.name, mime, bytes.length, file, sha256, req.user.id, b.clientId ?? null, b.versionOf ?? null, revisionNumber]);
            await db.query("INSERT INTO file_scan_jobs(file_id) VALUES($1)", [file]);
            await audit(db, req.user.id, c.org_id, "file.quarantined", file, {
                revisionRoot: b.versionOf ?? null,
                revisionNumber
            });
            await event(db, c.org_id, id, "file.uploaded");
            return {id: file, state: "quarantined"};
        });
    });
    app.get("/v1/channels/:id/files/:file/download", async (req, reply) => {
        const id = idParam(req), file = idParam(req, "file");
        const {row, bytes} = await readableFile(req.user.id, id, file);
        return reply.header("Content-Type", "application/octet-stream").header("Content-Disposition", `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(row.name).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16))}`).send(bytes);
    });
    app.get("/v1/channels/:id/files/:file/preview", async (req) => {
        const {bytes} = await readableFile(req.user.id, idParam(req), idParam(req, "file"), true);
        let source: string;
        try {
            source = new TextDecoder("utf-8", {fatal: true}).decode(bytes);
        } catch {
            throw new HttpError(422, "Preview unavailable: invalid UTF-8 text.");
        }
        let text = source.slice(0, previewLimit);
        if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
        return filePreviewSchema.parse({
            text,
            truncated: text.length < source.length,
            bytes: bytes.length,
            limit: previewLimit
        });
    });
    app.post("/v1/channels/:id/files/:file/retry", async (req) => {
        const id = idParam(req), file = idParam(req, "file");
        return transaction(async db => {
            const c = await channel(db, req.user.id, id, true);
            const owned = await db.query("SELECT 1 FROM files WHERE id=$1 AND channel_id=$2 AND created_by=$3 AND state='quarantined'", [file, id, req.user.id]);
            if (!owned.rowCount) throw new HttpError(404, "Retry unavailable");
            const changed = await db.query("UPDATE file_scan_jobs SET status='queued',attempts=0,available_at=now(),lease_id=NULL,lease_until=NULL,last_error=NULL WHERE file_id=$1 AND status='dead' RETURNING file_id", [file]);
            if (!changed.rowCount) throw new HttpError(409, "Only failed scan jobs can be retried");
            await audit(db, req.user.id, c.org_id, "file.scan_retried", file);
            return {ok: true};
        });
    });
    app.delete("/v1/channels/:id/files/:file", async (req) => {
        const id = idParam(req),
            file = idParam(req, "file");
        return transaction(async (db) => {
            const c = await channel(db, req.user.id, id, true);
            await channel(db, req.user.id, id);
            await requireUnheld(db,id);
            const r = await db.query(
                "UPDATE files SET state='deleted',lifecycle_revision=lifecycle_revision+1 WHERE (id=$1 OR revision_root=$1) AND channel_id=$2 AND created_by=$3 AND state<>'deleted' RETURNING id",
                [file, id, req.user.id],
            );
            if (!r.rowCount) {
                if ((await db.query("SELECT 1 FROM files WHERE id=$1 AND channel_id=$2 AND created_by=$3", [file,id,req.user.id])).rowCount) return {ok: true};
                throw new HttpError(404, "Only the uploader can delete this file");
            }
            await db.query("UPDATE file_scan_jobs SET status='cancelled',lease_id=NULL,lease_until=NULL WHERE file_id=ANY($1::uuid[])", [r.rows.map(row => row.id)]);
            await audit(db, req.user.id, c.org_id, "file.deleted", file);
            await event(db, c.org_id, id, "file.deleted");
            return {ok: true};
        });
    });
}
