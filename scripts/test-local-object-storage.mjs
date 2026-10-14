import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {setTimeout} from 'node:timers/promises';
import assert from 'node:assert/strict';
const exec=promisify(execFile);
if(process.env.TEST_OBJECT_STORAGE!=='true')throw new Error('Explicit local object-storage test opt-in required');
const api='http://localhost:4100',channel='44444444-4444-4444-8444-444444444444',origin='http://localhost:3101';
const signed=await fetch(`${api}/v1/session`,{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({email:'alice@acme.test',password:'Development123!'})});
assert.equal(signed.status,200);const cookie=signed.headers.get('set-cookie').split(';')[0];
const request=(route,method='GET',data)=>fetch(`${api}/v1${route}`,{method,headers:{cookie,origin,...(data?{'content-type':'application/json'}:{})},body:data?JSON.stringify(data):undefined});
async function inside(service,code){const r=await exec('docker',['exec',`concord-collaboration-${service}-1`,'node','--input-type=module','-e',`if(process.env.NODE_ENV!=='development')throw new Error('Local development only');${code}`]);return r.stdout.trim();}
const sdk=`import {S3Client,PutObjectCommand} from '@aws-sdk/client-s3';const client=new S3Client({endpoint:process.env.S3_ENDPOINT,region:'us-east-1',forcePathStyle:true,credentials:{accessKeyId:process.env.S3_ACCESS_KEY_ID,secretAccessKey:process.env.S3_SECRET_ACCESS_KEY},requestChecksumCalculation:'WHEN_REQUIRED'});`;
const content='Actual object storage round-trip and recovery',name=`object-store-${Date.now()}.txt`;
const uploaded=await request(`/channels/${channel}/files`,'POST',{clientId:crypto.randomUUID(),name,mime:'text/plain',content:Buffer.from(content).toString('base64')});
assert.equal(uploaded.status,200);const id=(await uploaded.json()).id,url=`/channels/${channel}/files/${id}/download`;
let row,stopped=false,corrupted=false,interruptedId="";
const metadata=async(fileId=id)=>JSON.parse(await inside('file-worker',`import {pool} from './services/core/db.ts';const r=await pool.query('SELECT f.*,j.attempts,j.status scan_status FROM files f JOIN file_scan_jobs j ON j.file_id=f.id WHERE f.id=$1',[${JSON.stringify(fileId)}]);console.log(JSON.stringify(r.rows[0]));await pool.end();`));
const overwrite=async body=>inside('file-worker',`${sdk}await client.send(new PutObjectCommand({Bucket:${JSON.stringify(row.object_bucket)},Key:${JSON.stringify(row.object_key)},Body:${JSON.stringify(body)}}));client.destroy();`);
try{
  for(let i=0;i<90;i++){row=await metadata();if(row.state==='ready')break;await setTimeout(1000);}
  assert.equal(row.state,'ready');assert.equal(row.storage_backend,'s3');
  const download=await request(url);assert.equal(download.status,200);assert.equal(await download.text(),content);
  const anonymous=Number(await inside('api',`console.log((await fetch(process.env.S3_ENDPOINT+'/'+${JSON.stringify(row.object_bucket+'/'+row.object_key)})).status);`));assert.equal(anonymous,403);
  const denied=Number(await inside('api',`${sdk}try{await client.send(new PutObjectCommand({Bucket:${JSON.stringify(row.object_bucket)},Key:'permission-probe',Body:'must be denied'}));console.log(200);}catch(e){console.log(e.$metadata?.httpStatusCode??0);}finally{client.destroy();}`));assert.equal(denied,403);
  await overwrite('Corrupt object');corrupted=true;assert.equal((await request(url)).status,503);
  await overwrite(content);corrupted=false;assert.equal(await (await request(url)).text(),content);
  await exec('docker',['stop','concord-collaboration-object-store-1']);stopped=true;
  assert.equal((await request(url)).status,503); // Retained local bytes must not silently become authoritative.
  assert.equal((await request(`/channels/${channel}/messages`)).status,200);
  const interrupted=await request(`/channels/${channel}/files`,'POST',{clientId:crypto.randomUUID(),name:`outage-${Date.now()}.txt`,mime:'text/plain',content:Buffer.from(content).toString('base64')});
  assert.equal(interrupted.status,200);interruptedId=(await interrupted.json()).id;
  let waiting;
  for(let i=0;i<60;i++){waiting=await metadata(interruptedId);if(waiting.attempts>0 && waiting.scan_status==='queued')break;await setTimeout(1000);}
  assert.equal(waiting.state,'quarantined');assert.equal(waiting.storage_backend,'local');assert.ok(waiting.attempts>0);assert.equal(waiting.scan_status,'queued');
  assert.equal((await request(`/channels/${channel}/files/${interruptedId}/download`)).status,409);
  await exec('docker',['start','concord-collaboration-object-store-1']);stopped=false;
  let restored;
  for(let i=0;i<60;i++){restored=await request(url);if(restored.status===200)break;await setTimeout(1000);}
  assert.equal(restored.status,200);assert.equal(await restored.text(),content);
  let promotedAfterRecovery;
  for(let i=0;i<60;i++){promotedAfterRecovery=await metadata(interruptedId);if(promotedAfterRecovery.state==='ready')break;await setTimeout(1000);}
  assert.equal(promotedAfterRecovery.state,'ready');assert.equal(promotedAfterRecovery.storage_backend,'s3');
  assert.equal(await (await request(`/channels/${channel}/files/${interruptedId}/download`)).text(),content);
  // This fixture's bytes were actually scanned; convert its pointer to local to exercise migration.
  const promotion=JSON.parse(await inside('file-worker',`import {pool} from './services/core/db.ts';import {promoteFile} from './services/core/promote-files.ts';await pool.query("UPDATE files SET storage_backend='local',object_key=NULL,object_bucket=NULL WHERE id=$1",[${JSON.stringify(id)}]);console.log(JSON.stringify({first:await promoteFile(${JSON.stringify(id)}),second:await promoteFile(${JSON.stringify(id)})}));await pool.end();`));
  assert.deepEqual(promotion,{first:true,second:false});assert.equal(await (await request(url)).text(),content);
  console.log(JSON.stringify({test:'real S3 provider',readyObjectVerified:true,anonymousDenied:true,readerWriteDenied:true,corruptionDenied:true,outageFailsClosed:true,messagingDuringOutage:true,restartBytesPersist:true,migrationRepeatable:true,uploadQuarantineDuringOutage:true,uploadPromotionAfterRecovery:true}));
}finally{
  if(stopped)await exec('docker',['start','concord-collaboration-object-store-1']);
  if(corrupted)await overwrite(content);
  await request(`/channels/${channel}/files/${id}`,'DELETE');
  if(interruptedId)await request(`/channels/${channel}/files/${interruptedId}`,'DELETE');
}
