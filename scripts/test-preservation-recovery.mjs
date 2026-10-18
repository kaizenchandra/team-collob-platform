import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile,unlink} from 'node:fs/promises';
import {CompactEncrypt,compactDecrypt} from 'jose';
import pg from 'pg';
import {command} from './backup-common.mjs';
if(process.env.ALLOW_LOCAL_BACKUP!=='true')throw new Error('Explicit local recovery opt-in required');
const api='http://localhost:4100',origin='http://localhost:3101',org=randomUUID(),team=randomUUID(),users={alice:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',bob:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',eve:'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'},cookies={},negative=[],channels=[],files=[];
const pool=new pg.Pool({connectionString:'postgres://concord:local-development-only@localhost:55432/concord',connectionTimeoutMillis:5000});
const response=(user,path,method='GET',body)=>fetch(api+path,{method,signal:AbortSignal.timeout(8000),headers:{cookie:cookies[user],origin,...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
const call=async(...args)=>{const r=await response(...args);assert.ok(r.ok,`Fixture ${args[2]??'GET'} failed ${r.status}`);return r.json();};
const scan=async id=>{for(let i=0;i<60;i++){if((await response('alice',`/v1/channels/${channels[0]}/files/${id}/download`)).status===200)return;await new Promise(r=>setTimeout(r,1000));}throw new Error('Recovery fixture requires a real clean scan');};
try{
  for(const name of Object.keys(users)){const email={alice:'alice@acme.test',bob:'bob@acme.test',eve:'eve@northstar.test'}[name];const r=await fetch(api+'/v1/session',{method:'POST',signal:AbortSignal.timeout(8000),headers:{origin,'content-type':'application/json'},body:JSON.stringify({email,password:'Development123!'})});assert.equal(r.status,200);cookies[name]=r.headers.get('set-cookie').split(';')[0];}
  await pool.query("INSERT INTO organizations(id,name) VALUES($1,'Preservation recovery exercise')",[org]);for(const [name,id] of Object.entries(users))await pool.query('INSERT INTO memberships VALUES($1,$2,$3,true)',[org,id,name==='bob'?'member':'owner']);await pool.query("INSERT INTO teams(id,org_id,name) VALUES($1,$2,'Recovery hold team')",[team,org]);for(const id of Object.values(users))await pool.query("INSERT INTO team_members VALUES($1,$2,$3,'member')",[org,team,id]);
  for(const [name,user,members] of [['Active hold','alice',[users.bob]],['Released hold','alice',[]],['Inaccessible owner hold','eve',[]]]){const c=await call(user,`/v1/organizations/${org}/channels`,'POST',{name,kind:'private',teamId:team,members});channels.push(c.id);}
  const [channel,released,hidden]=channels,base=`/v1/channels/${channel}`,content='Retained recovery file bytes',body='Held message survives independent restore',name=`preservation-${Date.now()}.txt`;
  const upload=async(versionOf)=>{const r=await call('alice',`${base}/files`,'POST',{name,mime:'text/plain',clientId:randomUUID(),content:Buffer.from(content).toString('base64'),...(versionOf?{versionOf}:{})});files.push(r.id);await scan(r.id);return r.id;};
  const file=await upload(),version=await upload(file);await call('alice',`${base}/files/${version}`,'DELETE');
  const message=(await call('bob',`${base}/messages`,'POST',{clientId:randomUUID(),body})).id,report=(await call('bob',`${base}/messages/${message}/report`,'POST',{reason:'other',details:'Held recovery report'})).report.id;
  const holdChange=(user,id,active,expectedRevision,reason)=>call(user,`/v1/channels/${id}/preservation`,'PUT',{active,reason,expectedRevision,confirm:true});
  await holdChange('alice',channel,true,0,'Confidential recovery case note');await holdChange('alice',released,true,0,'Closed recovery case note');await holdChange('alice',released,false,1,'Closed recovery case note');await holdChange('eve',hidden,true,0,'Inaccessible case note');
  const fixture={org,channel,released,hidden,message,report,file,body,content,deletedVersion:version,hold:await call('alice',`${base}/preservation`),releasedHold:await call('alice',`/v1/channels/${released}/preservation`),lifecycle:(await pool.query('SELECT id,lifecycle_revision FROM files WHERE channel_id=$1 ORDER BY id',[channel])).rows,versions:(await call('alice',`${base}/files/${file}/versions`)).versions.map(v=>[v.id,v.revision_number,v.state])};
  const backup=JSON.parse((await command(process.execPath,['scripts/coordinated-backup.mjs'])).toString());console.log(JSON.stringify({backup}));
  // Mutate only synthetic source data after the snapshot, proving recovery reads the archive.
  await holdChange('alice',channel,false,fixture.hold.revision,'Source note after snapshot');await call('bob',`${base}/messages/${message}`,'PATCH',{body:'Source edited after snapshot'});await call('alice',`${base}/files/${file}`,'DELETE');
  process.env.PRESERVATION_RESTORE_FIXTURE=JSON.stringify(fixture);
  const restored=(await command(process.execPath,['scripts/restore-coordinated-backup.mjs',backup.artifact])).toString().trim().split('\n').map(JSON.parse);assert.equal(restored[0].preservationMetadataVerified,true);assert.equal(restored[0].preservationApiVerified,true);assert.equal(restored[0].countsMatch,true);assert.equal(restored[1].cleanupComplete,true);for(const row of restored)console.log(JSON.stringify(row));
  delete process.env.PRESERVATION_RESTORE_FIXTURE;
  const key=await readFile('.data/backup-keys/local-core.key'),decrypted=await compactDecrypt(await readFile(backup.artifact,'utf8'),key),data=JSON.parse(Buffer.from(decrypted.plaintext).toString());assert.equal(data.version,10);
  for(const table of ['channel_preservation','files','file_scan_jobs']){const broken=structuredClone(data);broken.preservation[table].sha256='0'.repeat(64);const path=`.data/backups/preservation-mismatch-${randomUUID()}.jwe`;negative.push(path);await writeFile(path,await new CompactEncrypt(Buffer.from(JSON.stringify(broken))).setProtectedHeader({alg:'dir',enc:'A256GCM',cty:'application/concord-backup+json'}).encrypt(key),{flag:'wx',mode:0o600});let failure;try{await command(process.execPath,['scripts/restore-coordinated-backup.mjs',path]);}catch(e){failure=e;}assert.ok(failure);assert.match(failure.message,/Restored preservation digest mismatch/);assert.ok(failure.stdout.includes('"cleanupComplete":true'));console.log(JSON.stringify({digestMismatchRejected:table,failureCleanupComplete:true}));}
  console.log(JSON.stringify({sourceHoldBodyAndFileChangesDidNotAlterSnapshot:true}));
}finally{
  delete process.env.PRESERVATION_RESTORE_FIXTURE;for(const path of negative)await unlink(path).catch(()=>{});
  await pool.query('DELETE FROM file_scan_jobs WHERE file_id=ANY($1::uuid[])',[files]);
  for(const id of channels){for(const table of ['channel_preservation','message_reports','files','messages','drafts','channel_preferences','read_positions','channel_members','outbox']){await pool.query(`DELETE FROM ${table} WHERE channel_id=$1`,[id]);}await pool.query('DELETE FROM channels WHERE id=$1',[id]);}
  for(const table of ['audit','team_members','teams','presence','calendar_versions','memberships'])await pool.query(`DELETE FROM ${table} WHERE org_id=$1`,[org]);await pool.query('DELETE FROM organizations WHERE id=$1',[org]);
  // Remove only fixture spool files after database references are gone; archived encrypted artifact remains.
  if(files.length)await command('docker',['exec','concord-collaboration-api-1','node','--input-type=module','-e',"import {rm} from 'node:fs/promises';for(const id of JSON.parse(process.argv[1]))await rm('/app/.data/files/'+id,{force:true});",JSON.stringify(files)]);
  await pool.end();for(const cookie of Object.values(cookies))await fetch(api+'/v1/session',{method:'DELETE',signal:AbortSignal.timeout(5000),headers:{origin,cookie}}).catch(()=>{});
}
