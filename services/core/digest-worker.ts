import {rm,writeFile} from 'node:fs/promises';
import {setTimeout} from 'node:timers/promises';
import {migrate,pool} from './db.ts';
import {emailConfiguration} from './email.ts';
import {scheduleDigest,runDigestJob} from './digest-jobs.ts';
emailConfiguration();
const heartbeat='/tmp/concord-digest-heartbeat';
await rm(heartbeat,{force:true});
await migrate();
let stopping=false;process.on('SIGTERM',()=>{stopping=true;});process.on('SIGINT',()=>{stopping=true;});
while(!stopping){
  try{await scheduleDigest();const worked=await runDigestJob();await writeFile(heartbeat,String(Date.now()));if(!worked)await setTimeout(1000);}
  catch{await rm(heartbeat,{force:true});console.error(JSON.stringify({event:'digest_worker_unavailable'}));await setTimeout(3000);}
}
await pool.end();
