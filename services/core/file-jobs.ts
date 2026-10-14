import {objectStorageConfigured, putVerifiedObject} from "./object-storage.ts";
import {randomInt, randomUUID} from "node:crypto";
import {pool, transaction} from "./db.ts";
import {storedBytes, validateFile} from "./file-content.ts";
import {type ScanVerdict, scanWithClamav} from "./clamav.ts";
import {audit, event} from "./security.ts";

export async function runFileJob(scan: (data: Buffer) => Promise<ScanVerdict> = scanWithClamav) {
    const lease = randomUUID();
    const job = (await pool.query(`UPDATE file_scan_jobs SET status='running',attempts=attempts+1,lease_id=$1,lease_until=now()+interval '120 seconds'
    WHERE file_id=(SELECT file_id FROM file_scan_jobs WHERE ((status='queued' AND available_at<=now()) OR (status='running' AND lease_until<=now())) AND attempts<5 ORDER BY available_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`, [lease])).rows[0];
    if (!job) {
        await pool.query("UPDATE file_scan_jobs SET status='dead',last_error='scan_unavailable',lease_id=NULL,lease_until=NULL WHERE status='running' AND lease_until<=now() AND attempts>=5");
        return false;
    }
    try {
        const file = (await pool.query("SELECT * FROM files WHERE id=$1", [job.file_id])).rows[0];
        if (!file || file.state !== "quarantined") {
            await pool.query("UPDATE file_scan_jobs SET status='cancelled',lease_id=NULL,lease_until=NULL WHERE file_id=$1 AND lease_id=$2", [job.file_id, lease]);
            return true;
        }
        const bytes = await storedBytes(file);
        validateFile(file.name, file.mime, bytes);
        const result = await scan(bytes);
        if (!["ready", "rejected"].includes(result.state)) throw new Error("Invalid verdict");
        const object = result.state === "ready" && objectStorageConfigured() ? await putVerifiedObject(file, bytes) : null;
        await transaction(async db => {
            await db.query("SELECT id FROM channels WHERE id=$1 FOR UPDATE", [file.channel_id]);
            const current = await db.query("SELECT j.* FROM file_scan_jobs j JOIN files f ON f.id=j.file_id WHERE j.file_id=$1 AND j.lease_id=$2 AND j.lease_until>now() AND j.status='running' AND f.state='quarantined' FOR UPDATE OF j,f", [file.id, lease]);
            if (!current.rowCount) return;
            await db.query("UPDATE files SET state=$2,storage_backend=$3,object_key=$4,object_bucket=$5 WHERE id=$1", [file.id, result.state, object ? "s3" : file.storage_backend, object?.object_key ?? file.object_key, object?.object_bucket ?? file.object_bucket]);
            await db.query("UPDATE file_scan_jobs SET status='done',lease_id=NULL,lease_until=NULL,scanned_at=now(),last_error=NULL,scanner_version=$2 WHERE file_id=$1", [file.id, result.version.slice(0, 200)]);
            await audit(db, file.created_by, file.org_id, `file.${result.state}`, file.id);
            await event(db, file.org_id, file.channel_id, "file.scanned", {id: file.id, state: result.state});
        });
    } catch {
        const delay = Math.min(300, 2 ** job.attempts) + randomInt(1, 6);
        await pool.query("UPDATE file_scan_jobs SET status=CASE WHEN attempts>=5 THEN 'dead' ELSE 'queued' END,available_at=now()+($3*interval '1 second'),lease_id=NULL,lease_until=NULL,last_error='scan_unavailable' WHERE file_id=$1 AND lease_id=$2", [job.file_id, lease, delay]);
    }
    return true;
}
