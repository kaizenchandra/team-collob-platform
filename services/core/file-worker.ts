import { writeFile } from "node:fs/promises";
import { pool,migrate } from "./db.ts";
import { runFileJob } from "./file-jobs.ts";
import { setTimeout } from "node:timers/promises";
if(!process.env.CLAMAV_HOST)throw new Error("CLAMAV_HOST is required for the file worker");
if(process.env.NODE_ENV === "production" && (!process.env.DATABASE_URL || !process.env.FILE_ROOT)) throw new Error("Explicit database and storage configuration required");
await migrate();
let stopping=false;
process.on("SIGTERM",()=>{stopping=true;});process.on("SIGINT",()=>{stopping=true;});
while(!stopping){try{await writeFile("/tmp/concord-file-worker-heartbeat",String(Date.now()));if(!await runFileJob())await setTimeout(1000);}catch{console.error(JSON.stringify({event:"file_worker_unavailable"}));await setTimeout(3000);}}
await pool.end();
