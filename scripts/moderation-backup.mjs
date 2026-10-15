import {createHash,randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
export const moderationTables={channels:['id'],channel_members:['channel_id','user_id'],team_members:['team_id','user_id'],memberships:['org_id','user_id'],messages:['id'],message_mentions:['message_id','user_id'],message_reports:['id'],audit:['id'],outbox:['id']};
export async function moderationSnapshot(db){
  await db.query("SET TIME ZONE 'UTC'");await db.query("SET DateStyle TO 'ISO, YMD'");const manifest={};
  for(const [table,keys] of Object.entries(moderationTables)){
    const rows=(await db.query(`SELECT row_to_json(t)::text data FROM (SELECT * FROM ${table} ORDER BY ${keys.join(',')} LIMIT 50001) t`)).rows;if(rows.length>50000)throw new Error('Moderation backup row limit exceeded');const hash=createHash('sha256');for(const row of rows)hash.update(row.data+'\n');manifest[table]={count:rows.length,sha256:hash.digest('hex')};
  }
  return manifest;
}
export async function verifyModerationGraph(db){
  const broken=(await db.query(`SELECT r.id FROM message_reports r LEFT JOIN messages m ON m.id=r.message_id AND m.channel_id=r.channel_id AND m.org_id=r.org_id
    LEFT JOIN memberships mb ON mb.org_id=r.org_id AND mb.user_id=r.reporter_id
    WHERE m.id IS NULL OR mb.user_id IS NULL OR (r.status='open' AND (r.resolved_by IS NOT NULL OR r.resolved_at IS NOT NULL)) OR (r.status<>'open' AND (r.resolved_by IS NULL OR r.resolved_at IS NULL)) LIMIT 1`)).rows;if(broken.length)throw new Error('Restored moderation graph mismatch');
}
export async function verifyModerationFixture(db,app,f,signin){
  const alice=await signin('alice@acme.test'),bob=await signin('bob@acme.test'),eve=await signin('eve@northstar.test'),guest=await signin('guest@partner.test');
  const call=(cookie,url,method='GET',payload)=>app.inject({url,method,headers:{cookie,origin:'http://localhost:3100'},...(payload?{payload}:{})}),queue=`/v1/organizations/${f.org}/message-reports`,base=`/v1/channels/${f.visible}`,hidden=`/v1/channels/${f.hidden}`;
  for(const status of ['open','dismissed','removed']){const r=await call(alice,`${queue}?status=${status}`);assert.equal(r.statusCode,200);assert.deepEqual(r.json(),f.queues[status]);}
  assert.equal((await call(bob,queue)).statusCode,403);assert.equal((await call(guest,`${base}/messages`)).statusCode,404);assert.equal((await call(eve,`${base}/messages`)).statusCode,404);assert.equal((await call(alice,`${hidden}/messages`)).statusCode,404);
  const hiddenQueue=await call(eve,queue);assert.equal(hiddenQueue.statusCode,200);assert.deepEqual(hiddenQueue.json(),f.hiddenQueue);assert.equal((await call(alice,`${queue}/${f.hiddenReport}/resolve`,'POST',{revision:1,action:'dismiss'})).statusCode,404);
  const policy=(await call(bob,`${base}/messages`)).json().channel;assert.equal(policy.posting_restricted,true);assert.equal(policy.revision,f.policyRevision);
  assert.equal((await call(bob,`${base}/messages`,'POST',{clientId:randomUUID(),body:'Denied after recovery'})).statusCode,403);assert.equal((await call(bob,`${base}/messages/${f.messages[1]}`,'PATCH',{body:'Denied edit'})).statusCode,403);
  for(let i=0;i<f.messages.length;i++){const r=await call(bob,`${base}/messages/${f.messages[i]}/report`);assert.equal(r.statusCode,200);assert.deepEqual(r.json().report,f.receipts[i]);assert.ok(!Object.hasOwn(r.json().report,'resolution_note'));}
  const replay=await call(bob,`${base}/messages`,'POST',f.accepted);assert.equal(replay.statusCode,201);assert.equal(replay.json().id,f.messages[1]);
  const counts=async()=>({audit:Number((await db.query('SELECT count(*) FROM audit WHERE org_id=$1',[f.org])).rows[0].count),events:Number((await db.query('SELECT count(*) FROM outbox WHERE org_id=$1',[f.org])).rows[0].count)}),before=await counts();
  const retry=await call(alice,`${queue}/${f.reports[0]}/resolve`,'POST',{revision:1,action:'remove',note:'Snapshot removal'});assert.equal(retry.statusCode,200);assert.deepEqual(await counts(),before);
  const duplicate=await call(bob,`${base}/messages/${f.messages[2]}/report`,'POST',{reason:'other',details:'Snapshot pending'});assert.equal(duplicate.statusCode,200);assert.equal(duplicate.json().report.id,f.reports[2]);assert.deepEqual(await counts(),before);
  const resolved=await call(alice,`${queue}/${f.reports[2]}/resolve`,'POST',{revision:1,action:'remove',note:'Restored review'});assert.equal(resolved.statusCode,200);assert.equal((await call(bob,`${base}/messages/${f.messages[2]}/report`)).json().report.status,'removed');assert.deepEqual(await counts(),{audit:before.audit+2,events:before.events+1});assert.equal((await db.query('SELECT deleted FROM messages WHERE id=$1',[f.messages[2]])).rows[0].deleted,true);
  return true;
}
