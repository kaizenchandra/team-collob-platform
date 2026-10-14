import {writeFile} from 'node:fs/promises';
import {setTimeout} from 'node:timers/promises';
import {migrate,pool} from './db.ts';
import {emailConfiguration} from './email.ts';
import {scheduleDigest,runDigestJob} from './digest-jobs.ts';
emailConfiguration();
await migrate();
let stopping=false;process.on('SIGTERM',()=>{stopping=true;});process.on('SIGINT',()=>{stopping=true;});
while(!stopping){
  try{await writeFile('/tmp/concord-digest-heartbeat',String(Date.now()));await scheduleDigest();if(!await runDigestJob())await setTimeout(1000);}
  catch{console.error(JSON.stringify({event:'digest_worker_unavailable'}));await setTimeout(3000);}
}
await pool.end();
