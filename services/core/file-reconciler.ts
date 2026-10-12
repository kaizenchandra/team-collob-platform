import {writeFile} from "node:fs/promises";
import {setTimeout} from "node:timers/promises";
import {pool,migrate} from "./db.ts";
import {reconcileFiles} from "./file-reconciliation.ts";
if(!process.env.DATABASE_URL || !process.env.FILE_ROOT)throw new Error("Explicit database and file root required");
await migrate();
let stopping=false;
process.on("SIGTERM",()=>{stopping=true;});process.on("SIGINT",()=>{stopping=true;});
let next=0;
while(!stopping){
  await writeFile("/tmp/concord-file-reconciler-heartbeat",String(Date.now()));
  if(Date.now()>=next){
    try{console.log(JSON.stringify({event:"file_reconciliation",...await reconcileFiles()}));}
    catch{console.error(JSON.stringify({event:"file_reconciliation_unavailable"}));}
    next=Date.now()+60000;
  }
  await setTimeout(1000);
}
await pool.end();
