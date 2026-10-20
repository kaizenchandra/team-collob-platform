import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {assertWorkerHeartbeat} from '../services/core/worker-heartbeat.ts';
const now=1800000000000;
test('worker heartbeat validates freshness and exact future/expiry boundaries for each existing TTL',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'concord-heartbeat-')),file=path.join(root,'heartbeat');
  try{for(const ttl of [60000,120000]){
    for(const timestamp of [now,now-ttl+1,now+5000]){await writeFile(file,String(timestamp));await assertWorkerHeartbeat(file,ttl,now);}
    for(const timestamp of [now-ttl,now-ttl-1,now+5001]){await writeFile(file,String(timestamp));await assert.rejects(assertWorkerHeartbeat(file,ttl,now));}
  }}finally{await rm(root,{recursive:true,force:true});}
});
test('worker heartbeat rejects malformed and nonfinite timestamps rather than masking a stalled worker',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'concord-heartbeat-')),file=path.join(root,'heartbeat');
  try{for(const value of ['', ' ', 'Infinity','-Infinity','NaN','0','-1','1e15','0x1a3185c5000',String(now)+'.5','9007199254740992','not a timestamp']){await writeFile(file,value);await assert.rejects(assertWorkerHeartbeat(file,60000,now),{message:'Invalid worker heartbeat'},value);}
    await writeFile(file,` ${now}\n`);await assertWorkerHeartbeat(file,60000,now);
  }finally{await rm(root,{recursive:true,force:true});}
});
test('worker heartbeat fails for missing/unreadable files and invalid probe configuration',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'concord-heartbeat-')),file=path.join(root,'heartbeat');
  try{await assert.rejects(assertWorkerHeartbeat(file,60000,now));await mkdir(file);await assert.rejects(assertWorkerHeartbeat(file,60000,now));await rm(file,{recursive:true});await writeFile(file,String(now));
    for(const ttl of [0,-1,Infinity,NaN,0.5])await assert.rejects(assertWorkerHeartbeat(file,ttl,now));
    await assert.rejects(assertWorkerHeartbeat(file,60000,NaN));
  }finally{await rm(root,{recursive:true,force:true});}
});
