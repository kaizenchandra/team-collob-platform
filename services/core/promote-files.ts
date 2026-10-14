import {pool, transaction} from "./db.ts";
import {localBytes} from "./file-content.ts";
import {putVerifiedObject} from "./object-storage.ts";
import {audit} from "./security.ts";

export async function promoteFile(id: string) {
    const file = (await pool.query("SELECT * FROM files WHERE id=$1 AND state='ready' AND storage_backend='local'", [id])).rows[0];
    if (!file) return false;
    const object = await putVerifiedObject(file, await localBytes(file));
    return transaction(async db => {
        await db.query("SELECT id FROM channels WHERE id=$1 FOR UPDATE", [file.channel_id]);
        const updated = await db.query("UPDATE files SET storage_backend='s3',object_key=$2,object_bucket=$3 WHERE id=$1 AND state='ready' AND storage_backend='local' AND sha256=$4 RETURNING id", [file.id, object.object_key, object.object_bucket, file.sha256]);
        if (!updated.rowCount) return false;
        await audit(db, file.created_by, file.org_id, "file.storage_promoted", file.id);
        return true;
    });
}
