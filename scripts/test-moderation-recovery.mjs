import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile,unlink} from 'node:fs/promises';
import {CompactEncrypt,compactDecrypt} from 'jose';
import pg from 'pg';
import {command} from './backup-common.mjs';
if(process.env.ALLOW_LOCAL_BACKUP!=='true')throw new Error('Explicit local recovery opt-in required');
const api='http://localhost:4100',origin='http://localhost:3101',org=randomUUID(),team=randomUUID(),users={alice:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',bob:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',eve:'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',guest:'dddddddd-dddd-4ddd-8ddd-dddddddddddd'},emails={alice:'alice@acme.test',bob:'bob@acme.test',eve:'eve@northstar.test',guest:'guest@partner.test'},cookies={},negative=[];
const pool=new pg.Pool({connectionString:'postgres://concord:local-development-only@localhost:55432/concord',connectionTimeoutMillis:5000});
const call=async(user,path,method='GET',body)=>{const r=await fetch(api+path,{method,signal:AbortSignal.timeout(8000),headers:{cookie:cookies[user],origin,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});assert.ok(r.ok,`Synthetic ${method} failed ${r.status}`);return r.json();};
try{
  for(const [name,email] of Object.entries(emails)){const r=await fetch(api+'/v1/session',{method:'POST',signal:AbortSignal.timeout(8000),headers:{origin,'content-type':'application/json'},body:JSON.stringify({email,password:'Development123!'})});assert.equal(r.status,200);cookies[name]=r.headers.get('set-cookie').split(';')[0];}
  await pool.query("INSERT INTO organizations(id,name) VALUES($1,'Moderation recovery fixture')",[org]);
  for(const [name,id] of Object.entries(users))await pool.query('INSERT INTO memberships VALUES($1,$2,$3,true)',[org,id,name==='alice'?'owner':name==='eve'?'admin':name==='guest'?'guest':'member']);
  await pool.query("INSERT INTO teams(id,org_id,name) VALUES($1,$2,'Recovery policy team')",[team,org]);for(const name of ['alice','bob','eve'])await pool.query("INSERT INTO team_members VALUES($1,$2,$3,'member')",[org,team,users[name]]);
  const visible=(await call('alice',`/v1/organizations/${org}/channels`,'POST',{name:'Visible recovery private',kind:'private',teamId:team,members:[users.bob]})).id,hidden=(await call('bob',`/v1/organizations/${org}/channels`,'POST',{name:'Inaccessible recovery private',kind:'private',teamId:team,members:[users.eve]})).id,base=`/v1/channels/${visible}`,queue=`/v1/organizations/${org}/message-reports`,messages=[],reports=[],accepted={clientId:randomUUID(),body:'Accepted before policy snapshot'};
  for(let i=0;i<3;i++){const sent=await call('bob',`${base}/messages`,'POST',i===1?accepted:{clientId:randomUUID(),body:`Recovery content ${i}`});messages.push(sent.id);const reported=await call('bob',`${base}/messages/${sent.id}/report`,'POST',{reason:'other',details:i===2?'Snapshot pending':`Snapshot report ${i}`});reports.push(reported.report.id);}
  await call('alice',`${queue}/${reports[0]}/resolve`,'POST',{revision:1,action:'remove',note:'Snapshot removal'});await call('alice',`${queue}/${reports[1]}/resolve`,'POST',{revision:1,action:'dismiss',note:'Snapshot private note'});
  const hiddenMessage=await call('eve',`/v1/channels/${hidden}/messages`,'POST',{clientId:randomUUID(),body:'Hidden recovery content'}),hiddenReport=(await call('bob',`/v1/channels/${hidden}/messages/${hiddenMessage.id}/report`,'POST',{reason:'unsafe',details:'Private recovery case'})).report.id;
  const policy=await call('alice',`${base}/posting-policy`,'PATCH',{revision:1,restricted:true}),queues={};for(const status of ['open','dismissed','removed'])queues[status]=await call('alice',`${queue}?status=${status}`);
  const receipts=[];for(const mid of messages)receipts.push((await call('bob',`${base}/messages/${mid}/report`)).report);
  const fixture={org,visible,hidden,messages,reports,accepted,hiddenReport,policyRevision:policy.revision,queues,receipts,hiddenQueue:await call('eve',queue)};
  assert.equal(queues.open.items.length,1);assert.equal(fixture.hiddenQueue.items.length,1);
  const backup=JSON.parse((await command(process.execPath,['scripts/coordinated-backup.mjs'])).toString());console.log(JSON.stringify({backup}));
  await call('alice',`${base}/posting-policy`,'PATCH',{revision:policy.revision,restricted:false});await call('alice',`${queue}/${reports[2]}/resolve`,'POST',{revision:1,action:'dismiss',note:'Source changed after snapshot'});
  process.env.MODERATION_RESTORE_FIXTURE=JSON.stringify(fixture);const restored=(await command(process.execPath,['scripts/restore-coordinated-backup.mjs',backup.artifact])).toString().trim().split('\n').map(line=>JSON.parse(line));assert.equal(restored[0].moderationMetadataVerified,true);assert.equal(restored[0].moderationApiVerified,true);assert.equal(restored[1].cleanupComplete,true);for(const row of restored)console.log(JSON.stringify(row));
  const key=await readFile('.data/backup-keys/local-core.key'),decrypted=await compactDecrypt(await readFile(backup.artifact,'utf8'),key),data=JSON.parse(Buffer.from(decrypted.plaintext).toString());
  for(const table of ['message_reports','channels']){const broken=structuredClone(data);broken.moderation[table].sha256='0'.repeat(64);const path=`.data/backups/moderation-mismatch-${randomUUID()}.jwe`;negative.push(path);const encrypted=await new CompactEncrypt(Buffer.from(JSON.stringify(broken))).setProtectedHeader({alg:'dir',enc:'A256GCM',cty:'application/concord-backup+json'}).encrypt(key);await writeFile(path,encrypted,{flag:'wx',mode:0o600});let failure;try{await command(process.execPath,['scripts/restore-coordinated-backup.mjs',path]);}catch(e){failure=e;}assert.ok(failure);assert.match(failure.message,/Restored moderation digest mismatch/);assert.ok(failure.stdout.includes('"cleanupComplete":true'));console.log(JSON.stringify({digestMismatchRejected:table,failureCleanupComplete:true}));}
  console.log(JSON.stringify({sourcePolicyAndDecisionChangesDidNotAlterSnapshot:true}));
}finally{
  await pool.query('UPDATE memberships SET active=false WHERE org_id=$1',[org]);await pool.end();delete process.env.MODERATION_RESTORE_FIXTURE;for(const path of negative)await unlink(path).catch(()=>{});for(const cookie of Object.values(cookies))await fetch(api+'/v1/session',{method:'DELETE',signal:AbortSignal.timeout(5000),headers:{origin,cookie}}).catch(()=>{});
}
