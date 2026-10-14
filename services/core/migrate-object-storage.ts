import {migrate, pool} from "./db.ts";
import {objectStorageConfigured} from "./object-storage.ts";
import {promoteFile} from "./promote-files.ts";

if (!objectStorageConfigured()) throw new Error("Object storage must be configured");
await migrate();
let cursor = "00000000-0000-0000-0000-000000000000", promoted = 0, failed = 0, skipped = 0;
try {
    while (true) {
        const rows = (await pool.query("SELECT id FROM files WHERE state='ready' AND storage_backend='local' AND id>$1 ORDER BY id LIMIT 100", [cursor])).rows;
        if (!rows.length) break;
        for (const row of rows) {
            cursor = row.id;
            try {
                if (await promoteFile(row.id)) promoted++; else skipped++;
            } catch {
                failed++;
            }
        }
    }
    console.log(JSON.stringify({event: "object_migration", promoted, skipped, failed}));
    if (failed) process.exitCode = 1;
} finally {
    await pool.end();
}
