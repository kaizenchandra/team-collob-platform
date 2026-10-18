import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
export const retentionTables={channel_message_retention:['channel_id'],message_attachments:['message_id','file_id'],reactions:['message_id','user_id','emoji'],saved_messages:['message_id','user_id'],read_positions:['channel_id','user_id']};
export async function retentionSnapshot(db){
  await db.query("SET TIME ZONE 'UTC'");await db.query("SET DateStyle TO 'ISO, YMD'");const manifest={};
  for(const [table,keys] of Object.entries(retentionTables)){
    const rows=(await db.query(`SELECT row_to_json(t)::text data FROM (SELECT * FROM ${table} ORDER BY ${keys.join(',')} LIMIT 50001) t`)).rows;
    if(rows.length>50000)throw new Error('Retention backup row limit exceeded');
    const hash=createHash('sha256');for(const row of rows)hash.update(row.data+'\n');manifest[table]={count:rows.length,sha256:hash.digest('hex')};
  }
  return manifest;
}
export async function verifyRetentionGraph(db){
  assert.equal((await db.query("SELECT p.channel_id FROM channel_message_retention p LEFT JOIN channels c ON c.id=p.channel_id WHERE c.id IS NULL OR c.kind NOT IN ('standard','private','shared') OR p.revision<1 OR (p.days IS NOT NULL AND p.days NOT BETWEEN 1 AND 3650) LIMIT 1")).rowCount,0,'Restored retention policy graph mismatch');
  assert.equal((await db.query('SELECT a.message_id FROM message_attachments a JOIN messages m ON m.id=a.message_id JOIN files f ON f.id=a.file_id WHERE m.org_id<>f.org_id OR m.channel_id<>f.channel_id LIMIT 1')).rowCount,0,'Restored retention attachment graph mismatch');
}
export async function retentionFixtureRows(db,org){
  await db.query("SET TIME ZONE 'UTC'");await db.query("SET DateStyle TO 'ISO, YMD'");
  const result={},spec={messages:['t.org_id=$1','t.id'],channel_message_retention:['c.org_id=$1','t.channel_id','JOIN channels c ON c.id=t.channel_id'],channel_preservation:['c.org_id=$1','t.channel_id','JOIN channels c ON c.id=t.channel_id'],files:['t.org_id=$1','t.id'],message_attachments:['m.org_id=$1','t.message_id,t.file_id','JOIN messages m ON m.id=t.message_id'],message_mentions:['m.org_id=$1','t.message_id,t.user_id','JOIN messages m ON m.id=t.message_id'],reactions:['m.org_id=$1','t.message_id,t.user_id,t.emoji','JOIN messages m ON m.id=t.message_id'],saved_messages:['m.org_id=$1','t.message_id,t.user_id','JOIN messages m ON m.id=t.message_id'],read_positions:['c.org_id=$1','t.channel_id,t.user_id','JOIN channels c ON c.id=t.channel_id'],message_reports:['t.org_id=$1','t.id'],audit:['t.org_id=$1','t.id'],outbox:['t.org_id=$1','t.id']};
  for(const [table,[where,order,join='']] of Object.entries(spec))result[table]=(await db.query(`SELECT row_to_json(t)::text data FROM ${table} t ${join} WHERE ${where} ORDER BY ${order}`,[org])).rows.map(r=>r.data);
  return result;
}
export async function verifyRetentionFixtureSnapshot(db,f){assert.deepEqual(await retentionFixtureRows(db,f.org),f.records,'Restored retention fixture snapshot mismatch');}
export async function verifyRetentionFixture(db,app,f,signin){
  const alice=await signin('alice@acme.test'),bob=await signin('bob@acme.test'),eve=await signin('eve@northstar.test');
  const call=(cookie,url,method='GET',payload)=>app.inject({url,method,headers:{cookie,origin:'http://localhost:3100'},...(payload?{payload}:{})});
  const base='/v1/channels/'+f.applied,held='/v1/channels/'+f.held,policy=base+'/message-retention',heldPolicy=held+'/message-retention';
  const afterSignin=await retentionFixtureRows(db,f.org);
  for(const [table,rows] of Object.entries(f.records))if(table!=='audit')assert.deepEqual(afterSignin[table],rows);
  assert.deepEqual(afterSignin.audit.slice(0,f.records.audit.length),f.records.audit);assert.ok(afterSignin.audit.slice(f.records.audit.length).every(row=>JSON.parse(row).action==='identity.signed_in'));
  for(const [id,expected] of [[f.applied,f.appliedPolicy],[f.held,f.heldPolicy],[f.disabled,f.disabledPolicy],[f.defaultChannel,f.defaultPolicy]]){const r=await call(alice,'/v1/channels/'+id+'/message-retention');assert.equal(r.statusCode,200);assert.deepEqual(r.json(),expected);}
  assert.equal((await call(bob,policy)).statusCode,403);assert.equal((await call(eve,policy)).statusCode,404);assert.equal((await call(alice,'/v1/channels/'+f.hidden+'/message-retention')).statusCode,404);
  const history=(await call(bob,base+'/messages')).json(),tombstone=history.messages.find(m=>m.id===f.cleared);assert.ok(tombstone);assert.equal(tombstone.deleted,true);assert.equal(tombstone.body,'');assert.deepEqual(tombstone.mentions,[]);assert.deepEqual(tombstone.attachments,[]);assert.equal(history.messages.find(m=>m.id===f.recent).body,f.recentBody);
  const downloaded=await call(bob,base+'/files/'+f.file+'/download');assert.equal(downloaded.statusCode,200);assert.equal(downloaded.body,f.content);
  const report=await call(bob,base+'/messages/'+f.cleared+'/report');assert.equal(report.statusCode,200);assert.equal(report.json().report.status,'open');
  for(const id of [f.applied,f.disabled,f.defaultChannel]){const p=(await call(alice,'/v1/channels/'+id+'/message-retention/preview')).json();assert.equal(p.count,0);assert.equal(p.token,null);}
  for(const mid of [f.disabledMessage,f.defaultMessage])assert.equal((await db.query('SELECT deleted FROM messages WHERE id=$1',[mid])).rows[0].deleted,false);
  const hp=(await call(alice,heldPolicy+'/preview')).json();assert.equal(hp.held,true);assert.equal(hp.count,0);assert.equal(hp.token,null);
  const payload=p=>({expectedRevision:p.policyRevision,asOf:p.asOf,token:p.token,confirm:true});
  assert.equal((await call(alice,policy+'/apply','POST',payload(f.consumed))).statusCode,409);
  assert.equal((await call(bob,heldPolicy+'/apply','POST',payload(f.pending))).statusCode,403);assert.equal((await call(eve,heldPolicy+'/apply','POST',payload(f.pending))).statusCode,404);
  assert.equal((await call(alice,heldPolicy+'/apply','POST',payload(f.pending))).statusCode,409);
  assert.deepEqual(await retentionFixtureRows(db,f.org),afterSignin);
  const released=await call(alice,held+'/preservation','PUT',{active:false,reason:f.hold.reason,expectedRevision:f.hold.revision,confirm:true});assert.equal(released.statusCode,200);
  const afterRelease=await retentionFixtureRows(db,f.org);assert.equal((await call(alice,heldPolicy+'/apply','POST',payload(f.pending))).statusCode,409);assert.deepEqual(await retentionFixtureRows(db,f.org),afterRelease);
  const fresh=(await call(alice,heldPolicy+'/preview')).json();assert.equal(fresh.count,1);assert.equal(fresh.hasMore,false);assert.equal(fresh.held,false);assert.equal((await call(alice,heldPolicy+'/apply','POST',payload(fresh))).json().count,1);
  const afterApply=await retentionFixtureRows(db,f.org);assert.equal((await call(alice,heldPolicy+'/apply','POST',payload(fresh))).statusCode,409);assert.deepEqual(await retentionFixtureRows(db,f.org),afterApply);assert.equal((await db.query('SELECT body FROM messages WHERE id=$1',[f.pendingMessage])).rows[0].body,'');
  const disabled='/v1/channels/'+f.disabled+'/message-retention';const saved=await call(alice,disabled,'PUT',{days:1,expectedRevision:f.disabledPolicy.revision,confirm:true});assert.equal(saved.statusCode,200);assert.equal((await db.query('SELECT deleted FROM messages WHERE id=$1',[f.disabledMessage])).rows[0].deleted,false);
  return true;
}
