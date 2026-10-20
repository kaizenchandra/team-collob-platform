// Local-only, opt-in fault injection. Always resumes containers before exiting.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
const exec=promisify(execFile),api='http://localhost:4100',org='11111111-1111-4111-8111-111111111111',origin='http://localhost:3101',paused=new Set();
if(process.env.RUN_LOCAL_MEDIA_FAULTS!=='1')throw new Error('Set RUN_LOCAL_MEDIA_FAULTS=1; this pauses only the named loopback development containers. Run with no other calls or tests.');
const docker=async(...args)=>(await exec('docker',args,{timeout:15000})).stdout;
for(const service of ['api','postgres','livekit','media-redis']){
 const [c]=JSON.parse(await docker('inspect',`concord-collaboration-${service}-1`));assert.equal(c.Config.Labels['com.docker.compose.project'],'concord-collaboration');assert.equal(c.State.Status,'running');
 for(const bindings of Object.values(c.HostConfig.PortBindings??{}))for(const b of bindings??[])assert.equal(b.HostIp,'127.0.0.1','Refuse non-loopback deployment');
}
let cookie='',call='';const records=[];
async function request(path,body){const r=await fetch(api+path,{method:body===undefined?'GET':'POST',headers:{origin,'content-type':'application/json',cookie},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(20000)});const data=await r.json();return {status:r.status,data,cookie:r.headers.get('set-cookie')?.split(';')[0]};}
const resume=async()=>{for(const name of [...paused]){await docker('unpause',name);paused.delete(name);}};
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{void resume().finally(()=>process.exit(1));});
try{
 const auth=await request('/v1/session',{email:'alice@acme.test',password:'Development123!'});assert.equal(auth.status,200);cookie=auth.cookie;
 for(const service of ['livekit','media-redis','postgres']){
  const made=await request(`/v1/organizations/${org}/instant-meetings`,{clientId:randomUUID(),title:`Local ${service} recovery probe`,mode:'audio',userIds:[]});assert.equal(made.status,200);call=made.data.id;
  const path=`/v1/organizations/${org}/calls/${call}`,body={clientId:randomUUID(),recordingConsent:false},name=`concord-collaboration-${service}-1`;
  console.log(JSON.stringify({phase:service,status:'pausing'}));await docker('pause',name);paused.add(name);const started=Date.now();let failure;
  try{failure=await request(path+'/join',body);assert(failure.status>=500,`${service} outage must fail closed, received ${failure.status}`);assert.match(failure.data.error,/temporarily unavailable/i);}finally{await resume();}
  let recovered;const deadline=Date.now()+20000;do{recovered=await request(path+'/join',body);if(recovered.status!==503)break;await delay(1000);}while(Date.now()<deadline);assert.equal(recovered.status,200,`${service} recovery after bounded retries`);const repeated=await request(path+'/join',body);assert.equal(repeated.status,200);assert.equal(repeated.data.grantId,recovered.data.grantId);
  assert.equal((await request(path+'/end',{})).status,200);assert.equal((await request(path+'/end',{})).status,200);assert.equal((await request(path+'/join',body)).status,409);
  records.push({service,failedJoinStatus:failure.status,recoveredJoinStatus:recovered.status,idempotentRetry:true,endedJoinStatus:409,elapsedMs:Date.now()-started});console.log(JSON.stringify(records.at(-1)));call='';
 }
 await writeFile('docs/evidence/media-faults-0.1.127.json',JSON.stringify({recordedAt:new Date().toISOString(),scope:'Short local container-pause control-plane faults; no production soak or cross-network claim',records},null,2)+'\n');console.log(JSON.stringify(records,null,2));
}finally{await resume();if(call&&cookie)await request(`/v1/organizations/${org}/calls/${call}/end`,{}).catch(()=>{});}
