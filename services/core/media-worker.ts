import {writeFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {pool} from './db.ts';
import {reconcileMedia} from './media.ts';
import {mediaConfiguration} from './media-config.ts';
if(!mediaConfiguration())throw new Error('LiveKit configuration is required for the media reconciler');
let stopping=false;for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{stopping=true;});
while(!stopping){
  try{await reconcileMedia();await writeFile('/tmp/concord-media-heartbeat',String(Date.now()));}
  catch{console.error('Media reconciliation unavailable; connections require successful authorization heartbeats');}
  await delay(2000);
}
await pool.end();
