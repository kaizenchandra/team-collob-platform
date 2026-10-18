import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {retentionFixtureRows} from './retention-backup.mjs';
export async function fileRetentionSnapshot(db){
  await db.query("SET TIME ZONE 'UTC'");await db.query("SET DateStyle TO 'ISO, YMD'");
  const rows=(await db.query('SELECT row_to_json(t)::text data FROM (SELECT * FROM channel_file_retention ORDER BY channel_id LIMIT 50001) t')).rows;
  if(rows.length>50000)throw new Error('File retention backup row limit exceeded');
  const hash=createHash('sha256');for(const row of rows)hash.update(row.data+'\n');return {channel_file_retention:{count:rows.length,sha256:hash.digest('hex')}};
}
export async function verifyFileRetentionGraph(db){
  assert.equal((await db.query("SELECT p.channel_id FROM channel_file_retention p LEFT JOIN channels c ON c.id=p.channel_id WHERE c.id IS NULL OR c.kind NOT IN ('standard','private','shared') OR p.revision<1 OR (p.days IS NOT NULL AND p.days NOT BETWEEN 1 AND 3650) LIMIT 1")).rowCount,0,'Restored file retention graph mismatch');
}
export async function fileRetentionFixtureRows(db,org){
  const result=await retentionFixtureRows(db,org);
  result.channel_file_retention=(await db.query('SELECT row_to_json(t)::text data FROM channel_file_retention t JOIN channels c ON c.id=t.channel_id WHERE c.org_id=$1 ORDER BY t.channel_id',[org])).rows.map(r=>r.data);
  result.file_scan_jobs=(await db.query('SELECT row_to_json(t)::text data FROM file_scan_jobs t JOIN files f ON f.id=t.file_id WHERE f.org_id=$1 ORDER BY t.file_id',[org])).rows.map(r=>r.data);
  return result;
}
export async function verifyFileRetentionFixtureSnapshot(db,f){assert.deepEqual(await fileRetentionFixtureRows(db,f.org),f.records,'Restored file retention fixture snapshot mismatch');}
export async function verifyFileRetentionFixture(db,app,f,signin,scanRestored=false){
  const alice=await signin('alice@acme.test'),bob=await signin('bob@acme.test'),eve=await signin('eve@northstar.test');
  const call=(cookie,url,method='GET',payload)=>app.inject({url,method,headers:{cookie,origin:'http://localhost:3100'},...(payload?{payload}:{})});
  const base=id=>'/v1/channels/'+id,policy=id=>base(id)+'/file-retention',payload=p=>({expectedRevision:p.policyRevision,asOf:p.asOf,token:p.token,confirm:true});
  const state=()=>fileRetentionFixtureRows(db,f.org),afterSignin=await state();
  for(const [table,rows] of Object.entries(f.records))if(table!=='audit')assert.deepEqual(afterSignin[table],rows);
  assert.deepEqual(afterSignin.audit.slice(0,f.records.audit.length),f.records.audit);assert.ok(afterSignin.audit.slice(f.records.audit.length).every(row=>JSON.parse(row).action==='identity.signed_in'));
  for(const [id,expected] of [[f.applied,f.appliedPolicy],[f.held,f.heldPolicy],[f.disabled,f.disabledPolicy],[f.defaultChannel,f.defaultPolicy]]){const r=await call(alice,policy(id));assert.equal(r.statusCode,200);assert.deepEqual(r.json(),expected);}
  assert.equal((await call(bob,policy(f.applied))).statusCode,403);assert.equal((await call(eve,policy(f.applied))).statusCode,404);assert.equal((await call(alice,policy(f.hidden))).statusCode,404);
  const message=(await call(bob,base(f.applied)+'/messages')).json().messages.find(m=>m.id===f.message);assert.equal(message.body,f.body);assert.equal(message.deleted,false);assert.deepEqual(message.attachments,f.appliedFiles.map(file=>({id:file.id,name:null,state:'unavailable'})).sort((a,b)=>a.id.localeCompare(b.id)));
  const {storedBytes}=await import('./services/core/file-content.ts');
  for(const file of f.appliedFiles){
    const row=(await db.query('SELECT * FROM files WHERE id=$1',[file.id])).rows[0];assert.equal(row.state,'deleted');assert.equal(row.lifecycle_revision,file.revision);assert.equal((await storedBytes(row)).toString(),file.content);
    assert.equal((await call(bob,base(f.applied)+'/files/'+file.id+'/download')).statusCode,404);assert.equal((await call(eve,base(f.applied)+'/files/'+file.id+'/download')).statusCode,404);
    const job=(await db.query('SELECT status,lease_id,lease_until FROM file_scan_jobs WHERE file_id=$1',[file.id])).rows[0];assert.deepEqual(job,{status:'cancelled',lease_id:null,lease_until:null});
  }
  for(const file of f.keptFiles){const download=await call(bob,base(file.channel)+'/files/'+file.id+'/download');assert.equal(download.statusCode,200);assert.equal(download.body,file.content);assert.equal((await call(eve,base(file.channel)+'/files/'+file.id+'/download')).statusCode,404);}
  for(const id of [f.applied,f.disabled,f.defaultChannel]){const p=(await call(alice,policy(id)+'/preview')).json();assert.equal(p.count,0);assert.equal(p.token,null);}
  const held=(await call(alice,policy(f.held)+'/preview')).json();assert.equal(held.held,true);assert.equal(held.token,null);
  assert.equal((await call(alice,policy(f.applied)+'/apply','POST',payload(f.consumed))).statusCode,409);assert.equal((await call(bob,policy(f.held)+'/apply','POST',payload(f.pending))).statusCode,403);assert.equal((await call(eve,policy(f.held)+'/apply','POST',payload(f.pending))).statusCode,404);assert.equal((await call(alice,policy(f.held)+'/apply','POST',payload(f.pending))).statusCode,409);assert.deepEqual(await state(),afterSignin);
  const released=await call(alice,base(f.held)+'/preservation','PUT',{active:false,reason:f.hold.reason,expectedRevision:f.hold.revision,confirm:true});assert.equal(released.statusCode,200);const afterRelease=await state();assert.equal((await call(alice,policy(f.held)+'/apply','POST',payload(f.pending))).statusCode,409);assert.deepEqual(await state(),afterRelease);
  const fresh=(await call(alice,policy(f.held)+'/preview')).json();assert.equal(fresh.count,1);assert.equal(fresh.families,1);const applied=await call(alice,policy(f.held)+'/apply','POST',payload(fresh));assert.equal(applied.statusCode,200);assert.equal(applied.json().count,1);const afterApply=await state();assert.equal((await call(alice,policy(f.held)+'/apply','POST',payload(fresh))).statusCode,409);assert.deepEqual(await state(),afterApply);
  const [original,version]=f.appliedFiles,restore=file=>base(f.applied)+'/files/'+file.id+'/restore',recovery=file=>({expectedRevision:file.revision,confirm:true});
  const list=await call(bob,base(f.applied)+'/deleted-files');assert.equal(list.statusCode,200);assert.deepEqual(list.json().files.map(file=>file.id).sort(),f.appliedFiles.map(file=>file.id).sort());assert.deepEqual((await call(alice,base(f.applied)+'/deleted-files')).json().files,[]);
  assert.equal((await call(alice,restore(original),'POST',recovery(original))).statusCode,404);assert.equal((await call(eve,restore(original),'POST',recovery(original))).statusCode,404);assert.equal((await call(bob,restore(version),'POST',recovery(version))).statusCode,409);assert.equal((await call(bob,restore(original),'POST',{expectedRevision:original.revision-1,confirm:true})).statusCode,409);
  for(const file of [original,version]){
    assert.equal((await call(bob,restore(file),'POST',recovery(file))).statusCode,200);const row=(await db.query('SELECT * FROM files WHERE id=$1',[file.id])).rows[0];assert.equal(row.state,'quarantined');assert.equal(row.lifecycle_revision,file.revision+1);assert.equal((await storedBytes(row)).toString(),file.content);assert.equal((await call(bob,base(f.applied)+'/files/'+file.id+'/download')).statusCode,409);
    const job=(await db.query('SELECT status,attempts,lease_id,lease_until,last_error,scanner_version,scanned_at FROM file_scan_jobs WHERE file_id=$1',[file.id])).rows[0];assert.deepEqual(job,{status:'queued',attempts:0,lease_id:null,lease_until:null,last_error:null,scanner_version:null,scanned_at:null});
  }
  assert.equal((await call(alice,policy(f.applied)+'/preview')).json().count,2);assert.equal((await call(alice,policy(f.applied)+'/apply','POST',payload(f.consumed))).statusCode,409);
  if(scanRestored){
    const {runFileJob}=await import('./services/core/file-jobs.ts');
    for(const file of [original,version]){
      await db.query("UPDATE file_scan_jobs SET available_at='1900-01-01' WHERE file_id=$1 AND status='queued'",[file.id]);const started=Date.now();assert.equal(await runFileJob(),true);
      const row=(await db.query('SELECT f.state,j.status,j.scanner_version,j.scanned_at FROM files f JOIN file_scan_jobs j ON j.file_id=f.id WHERE f.id=$1',[file.id])).rows[0];assert.equal(row.state,'ready');assert.equal(row.status,'done');assert.ok(row.scanner_version.startsWith('ClamAV '));assert.ok(new Date(row.scanned_at).getTime()>=started-1000);
      for(const cookie of [alice,bob]){const download=await call(cookie,base(f.applied)+'/files/'+file.id+'/download');assert.equal(download.statusCode,200);assert.equal(download.body,file.content);}assert.equal((await call(eve,base(f.applied)+'/files/'+file.id+'/download')).statusCode,404);
    }
    const history=(await call(bob,base(f.applied)+'/messages')).json().messages.find(m=>m.id===f.message);assert.equal(history.body,f.body);assert.deepEqual(history.attachments,f.appliedFiles.map(file=>({id:file.id,name:file.name,state:'ready'})).sort((a,b)=>a.id.localeCompare(b.id)));
  }
  const saved=await call(alice,policy(f.disabled),'PUT',{days:1,expectedRevision:f.disabledPolicy.revision,confirm:true});assert.equal(saved.statusCode,200);const disabledFile=f.keptFiles.find(file=>file.channel===f.disabled);assert.equal((await db.query('SELECT state FROM files WHERE id=$1',[disabledFile.id])).rows[0].state,'ready');
  return true;
}
