import {rm, writeFile} from "node:fs/promises";
import {setTimeout} from "node:timers/promises";
import {migrate, pool} from "./db.ts";
import {reconcileFiles} from "./file-reconciliation.ts";

if (!process.env.DATABASE_URL || !process.env.FILE_ROOT) throw new Error("Explicit database and file root required");
const heartbeat = "/tmp/concord-file-reconciler-heartbeat";
await rm(heartbeat, {force: true});
await migrate();
let stopping = false;
process.on("SIGTERM", () => {
    stopping = true;
});
process.on("SIGINT", () => {
    stopping = true;
});
let next = 0;
while (!stopping) {
    if (Date.now() >= next) {
        try {
            const result = await reconcileFiles();
            await writeFile(heartbeat, String(Date.now()));
            console.log(JSON.stringify({event: "file_reconciliation", ...result}));
        } catch {
            await rm(heartbeat, {force: true});
            console.error(JSON.stringify({event: "file_reconciliation_unavailable"}));
        }
        next = Date.now() + 60000;
    }
    await setTimeout(1000);
}
await pool.end();
