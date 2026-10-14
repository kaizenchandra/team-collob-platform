import assert from 'node:assert/strict';
import {writeFile,readFile,unlink} from 'node:fs/promises';
import {command} from './backup-common.mjs';
if(process.env.ALLOW_LOCAL_BACKUP!=='true')throw new Error('Explicit local backup test opt-in required');
const api='http://localhost:4100',channel='44444444-4444-4444-8444-444444444444',origin='http://localhost:3101';
const login=await fetch(`${api}/v1/session`,{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({email:'alice@acme.test',password:'Development123!'})});assert.equal(login.status,200);
const cookie=login.headers.get('set-cookie').split(';')[0];
const name=`Recovery fixture ${Date.now()}.txt`;
const upload=await fetch(`${api}/v1/channels/${channel}/files`,{method:'POST',headers:{origin,cookie,'content-type':'application/json'},body:JSON.stringify({name,mime:'text/plain',clientId:crypto.randomUUID(),content:Buffer.from('Real restore authorization and object content').toString('base64')})});assert.equal(upload.status,200);const id=(await upload.json()).id;
let corrupt;
try{
  let ready=false;for(let i=0;i<60;i++){const r=await fetch(`${api}/v1/channels/${channel}/files/${id}/download`,{headers:{cookie}});if(r.status===200){ready=true;break;}await new Promise(r=>setTimeout(r,1000));}assert.ok(ready,'Fixture must pass real scan/object promotion');
  const revision=await fetch(`${api}/v1/channels/${channel}/files`,{method:'POST',headers:{origin,cookie,'content-type':'application/json'},body:JSON.stringify({name,mime:'text/plain',versionOf:id,clientId:crypto.randomUUID(),content:Buffer.from('Second revision survives original deletion and restore').toString('base64')})});assert.equal(revision.status,200);const revisionId=(await revision.json()).id;
  let revisionReady=false;for(let i=0;i<60;i++){const r=await fetch(`${api}/v1/channels/${channel}/files/${revisionId}/download`,{headers:{cookie}});if(r.status===200){revisionReady=true;break;}await new Promise(r=>setTimeout(r,1000));}assert.ok(revisionReady,'Revision must pass real scanning and object promotion');
  const made=JSON.parse((await command(process.execPath,['scripts/coordinated-backup.mjs'])).toString());console.log(JSON.stringify({backup:made}));
  // Source deletion after snapshot must not affect independent recovery.
  assert.equal((await fetch(`${api}/v1/channels/${channel}/files/${id}`,{method:'DELETE',headers:{origin,cookie}})).status,200);
  const restored=(await command(process.execPath,['scripts/restore-coordinated-backup.mjs',made.artifact])).toString().trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(restored[0].revisionMetadataVerified,true);assert.ok(restored[0].revisionRootsVerified.includes(id),'The restored fixture lineage must pass API history and exact downloads');assert.equal(restored[0].authorizedDownload,true);assert.equal(restored[0].crossTenantDenied,true);assert.equal(restored[0].countsMatch,true);assert.equal(restored[1].cleanupComplete,true);for(const result of restored)console.log(JSON.stringify(result));
  const text=await readFile(made.artifact,'utf8'),offset=text.length-20;corrupt=made.artifact+'.corrupt';await writeFile(corrupt,text.slice(0,offset)+(text[offset]==='A'?'B':'A')+text.slice(offset+1),{mode:0o600,flag:'wx'});
  await assert.rejects(command(process.execPath,['scripts/restore-coordinated-backup.mjs',corrupt]),/JWEDecryptionFailed|decryption operation failed/);
  console.log(JSON.stringify({tamperedArtifactRejected:true,sourceDeletionDidNotChangeSnapshot:true}));
}finally{
  await fetch(`${api}/v1/channels/${channel}/files/${id}`,{method:'DELETE',headers:{origin,cookie}});
  if(corrupt)await unlink(corrupt).catch(()=>{});
}
