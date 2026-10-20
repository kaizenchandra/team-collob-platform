import {rm, writeFile} from "node:fs/promises";
import {migrate, pool} from "./db.ts";
import {runFileJob} from "./file-jobs.ts";
import {setTimeout} from "node:timers/promises";

if (!process.env.CLAMAV_HOST) throw new Error("CLAMAV_HOST is required for the file worker");
if (process.env.NODE_ENV === "production" && (!process.env.DATABASE_URL || !process.env.FILE_ROOT)) throw new Error("Explicit database and storage configuration required");
const heartbeat = "/tmp/concord-file-worker-heartbeat";
await rm(heartbeat, {force: true});
await migrate();
let stopping = false;
process.on("SIGTERM", () => {
    stopping = true;
});
process.on("SIGINT", () => {
    stopping = true;
});
while (!stopping) {
    try {
        const worked = await runFileJob();
        await writeFile(heartbeat, String(Date.now()));
        if (!worked) await setTimeout(1000);
    } catch {
        await rm(heartbeat, {force: true});
        console.error(JSON.stringify({event: "file_worker_unavailable"}));
        await setTimeout(3000);
    }
}
await pool.end();
