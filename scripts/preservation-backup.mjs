import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
export const preservationTables={channel_preservation:['channel_id'],files:['id'],file_scan_jobs:['file_id']};
export async function preservationSnapshot(db){
  await db.query("SET TIME ZONE 'UTC'");await db.query("SET DateStyle TO 'ISO, YMD'");const manifest={};
  for(const [table,keys] of Object.entries(preservationTables)){
    const rows=(await db.query(`SELECT row_to_json(t)::text data FROM (SELECT * FROM ${table} ORDER BY ${keys.join(',')} LIMIT 50001) t`)).rows;
    if(rows.length>50000)throw new Error('Preservation backup row limit exceeded');
    const hash=createHash('sha256');for(const row of rows)hash.update(row.data+'\n');manifest[table]={count:rows.length,sha256:hash.digest('hex')};
  }
  return manifest;
}
export async function verifyPreservationGraph(db){
  assert.equal((await db.query("SELECT p.channel_id FROM channel_preservation p LEFT JOIN channels c ON c.id=p.channel_id WHERE c.id IS NULL OR c.kind NOT IN ('standard','private','shared') OR p.revision<1 OR (p.active AND length(trim(p.reason))=0) LIMIT 1")).rowCount,0,'Restored preservation graph mismatch');
  assert.equal((await db.query('SELECT f.id FROM files f WHERE f.lifecycle_revision<1 OR NOT EXISTS(SELECT 1 FROM channels c WHERE c.id=f.channel_id AND c.org_id=f.org_id) LIMIT 1')).rowCount,0,'Restored file lifecycle graph mismatch');
}
export async function verifyPreservationFixture(db,app,f,signin){
  const alice=await signin('alice@acme.test'),bob=await signin('bob@acme.test'),eve=await signin('eve@northstar.test');
  const call=(cookie,url,method='GET',payload)=>app.inject({url,method,headers:{cookie,origin:'http://localhost:3100'},...(payload?{payload}:{})});
  const base='/v1/channels/'+f.channel,hold=base+'/preservation',message=base+'/messages/'+f.message,file=base+'/files/'+f.file;
  assert.deepEqual((await call(alice,hold)).json(),f.hold);assert.deepEqual((await call(alice,'/v1/channels/'+f.released+'/preservation')).json(),f.releasedHold);
  assert.equal((await call(bob,hold)).statusCode,403);assert.equal((await call(eve,hold)).statusCode,404);assert.equal((await call(alice,'/v1/channels/'+f.hidden+'/preservation')).statusCode,404);
  const history=await call(bob,base+'/messages');assert.equal(history.statusCode,200);assert.ok(!history.body.includes(f.hold.reason));assert.equal(history.json().messages.find(m=>m.id===f.message).body,f.body);
  assert.equal((await call(bob,file+'/download')).body,f.content);
  const versions=await call(alice,file+'/versions');assert.equal(versions.statusCode,200);assert.deepEqual(versions.json().versions.map(v=>[v.id,v.revision_number,v.state]),f.versions);
  const state=async()=>({hold:(await db.query('SELECT * FROM channel_preservation WHERE channel_id=$1',[f.channel])).rows,message:(await db.query('SELECT * FROM messages WHERE id=$1',[f.message])).rows,report:(await db.query('SELECT * FROM message_reports WHERE id=$1',[f.report])).rows,files:(await db.query('SELECT * FROM files WHERE channel_id=$1 ORDER BY id',[f.channel])).rows,jobs:(await db.query('SELECT j.* FROM file_scan_jobs j JOIN files f ON f.id=j.file_id WHERE f.channel_id=$1 ORDER BY j.file_id',[f.channel])).rows,audit:Number((await db.query('SELECT count(*) FROM audit WHERE org_id=$1',[f.org])).rows[0].count),events:Number((await db.query('SELECT count(*) FROM outbox WHERE org_id=$1',[f.org])).rows[0].count)});
  const before=await state();
  assert.equal((await call(bob,message,'PATCH',{body:'Forbidden restored edit'})).statusCode,409);
  for(const cookie of [alice,bob])assert.equal((await call(cookie,message,'DELETE')).statusCode,409);
  assert.equal((await call(alice,file,'DELETE')).statusCode,409);
  assert.equal((await call(alice,`/v1/organizations/${f.org}/message-reports/${f.report}/resolve`,'POST',{revision:1,action:'remove'})).statusCode,409);
  assert.equal((await call(bob,hold,'PUT',{active:false,reason:'',expectedRevision:f.hold.revision,confirm:true})).statusCode,403);
  assert.equal((await call(alice,hold,'PUT',{active:false,reason:'',expectedRevision:f.hold.revision-1,confirm:true})).statusCode,409);
  assert.deepEqual(await state(),before);
  const rows=(await db.query('SELECT id,lifecycle_revision FROM files WHERE channel_id=$1 ORDER BY id',[f.channel])).rows;assert.deepEqual(rows,f.lifecycle);
  const deletedRevision=f.lifecycle.find(row=>row.id===f.deletedVersion).lifecycle_revision;
  const version=base+'/files/'+f.deletedVersion;
  assert.equal((await call(alice,version+'/restore','POST',{expectedRevision:deletedRevision-1,confirm:true})).statusCode,409);
  assert.equal((await call(alice,version+'/restore','POST',{expectedRevision:deletedRevision,confirm:true})).statusCode,200);
  assert.equal((await call(bob,version+'/download')).statusCode,409);
  const job=(await db.query('SELECT status,attempts,lease_id,scanner_version FROM file_scan_jobs WHERE file_id=$1',[f.deletedVersion])).rows[0];assert.deepEqual(job,{status:'queued',attempts:0,lease_id:null,scanner_version:null});
  const released=await call(alice,hold,'PUT',{active:false,reason:f.hold.reason,expectedRevision:f.hold.revision,confirm:true});assert.equal(released.statusCode,200);assert.equal(released.json().revision,f.hold.revision+1);
  assert.equal((await call(bob,message,'PATCH',{body:'Allowed restored edit after release'})).statusCode,200);assert.equal((await call(bob,message,'DELETE')).statusCode,200);assert.equal((await call(alice,file,'DELETE')).statusCode,200);
  return true;
}
