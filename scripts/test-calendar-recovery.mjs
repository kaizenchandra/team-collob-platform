import {reminderFixtureRows} from './calendar-backup.mjs';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile,unlink} from 'node:fs/promises';
import {CompactEncrypt,compactDecrypt} from 'jose';
import pg from 'pg';
import {command} from './backup-common.mjs';
if(process.env.ALLOW_LOCAL_BACKUP!=='true')throw new Error('Explicit local recovery opt-in required');
const api='http://localhost:4100',origin='http://localhost:3101',org=randomUUID(),aliceId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',bobId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',guestId='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const pool=new pg.Pool({connectionString:'postgres://concord:local-development-only@localhost:55432/concord',connectionTimeoutMillis:5000});
const login=async email=>{const r=await fetch(`${api}/v1/session`,{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({email,password:'Development123!'})});assert.equal(r.status,200);return r.headers.get('set-cookie').split(';')[0];};
const alice=await login('alice@acme.test'),bob=await login('bob@acme.test');let first='',dueMeeting='',negative;
const call=async(cookie,path,method='GET',body)=>{const r=await fetch(api+path,{method,headers:{cookie,origin,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});assert.ok(r.ok,`Fixture ${method} failed ${r.status}`);return r.json();};
try{
  await pool.query("INSERT INTO organizations(id,name) VALUES($1,'Calendar recovery fixture')",[org]);await pool.query("INSERT INTO memberships VALUES($1,$2,'owner',true),($1,$3,'member',true),($1,$4,'guest',true)",[org,aliceId,bobId,guestId]);
  const base=`/v1/organizations/${org}/meetings`,request={title:'Recovery month series',startsAt:'2030-01-31T10:00:00Z',endsAt:'2030-01-31T11:00:00Z',timezone:'UTC',attendees:[bobId,guestId],clientId:randomUUID(),recurrence:{frequency:'monthly',interval:1,count:4,repeatedTime:'reject',monthDayPolicy:'constrain'}};
  const made=await call(alice,base,'POST',request);first=made.id;await call(alice,`${base}/${made.occurrenceIds[3]}`,'PATCH',{cancelled:true});
  let schedule=await call(alice,`${base}/${first}/series`);await call(alice,`${base}/${first}/series/details`,'PUT',{revision:schedule.revision,title:'Recovery updated series',description:'Snapshot preserves exceptions',attendees:[bobId,guestId]});
  schedule=await call(alice,`${base}/${first}/series`);await call(alice,`${base}/${first}/series/schedule`,'PUT',{revision:schedule.revision,startsAt:'2032-02-29T10:00:00Z',endsAt:'2032-02-29T11:00:00Z',timezone:'UTC',frequency:'yearly',interval:1,repeatedTime:'reject',monthDayPolicy:'constrain'});
  let owner=(await call(alice,base)).meetings;const row=owner.find(m=>m.id===first);await call(alice,`${base}/${first}/details`,'PUT',{revision:row.revision,title:'Single occurrence exception',description:'Recipient removed from this occurrence',startsAt:row.starts_at,endsAt:row.ends_at,timezone:row.timezone,attendees:[guestId]});await call(bob,`${base}/${made.occurrenceIds[1]}`,'PATCH',{response:'accepted'});
  schedule=await call(alice,`${base}/${first}/series`);await call(alice,`${base}/${first}/series/schedule`,'PUT',{revision:schedule.revision,startsAt:schedule.anchor_starts_at,endsAt:schedule.anchor_ends_at,timezone:schedule.timezone,frequency:schedule.frequency,interval:schedule.interval,repeatedTime:schedule.repeated_time,monthDayPolicy:schedule.month_day_policy,count:6});
  await call(alice,`${base}/${first}/reminder`,'PUT',{minutes:60});
  const second=made.occurrenceIds[1];await call(bob,`${base}/${second}/reminder`,'PUT',{minutes:15});const secondRow=(await call(bob,base)).meetings.find(m=>m.id===second);await call(bob,`${base}/${second}/reminder/dismiss`,'POST',{startsAt:secondRow.starts_at});
  const dueCreated=await call(alice,base,'POST',{title:'Recovery due reminder',startsAt:new Date(Date.now()+30*60000).toISOString(),endsAt:new Date(Date.now()+60*60000).toISOString(),timezone:'UTC',attendees:[bobId]});dueMeeting=dueCreated.id;await call(bob,`${base}/${dueMeeting}/reminder`,'PUT',{minutes:60});
  const due=await call(bob,`/v1/organizations/${org}/meeting-reminders`);assert.equal(due.items.length,1,'Fixture requires nonquiet due projection');const reminders=await reminderFixtureRows(pool,org);
  owner=(await call(alice,base)).meetings;const recipient=(await call(bob,base)).meetings;schedule=await call(alice,`${base}/${first}/series`);
  const fixture={org,first,ids:made.occurrenceIds,owner,recipient,schedule,request,reminders,due,dueMeeting};
  const backup=JSON.parse((await command(process.execPath,['scripts/coordinated-backup.mjs'])).toString());console.log(JSON.stringify({backup}));
  await call(alice,`${base}/${first}/series`,'PATCH',{cancelled:true});await call(bob,`${base}/${dueMeeting}/reminder`,'PUT',{minutes:0});await call(alice,`${base}/${dueMeeting}`,'PATCH',{cancelled:true});
  process.env.CALENDAR_RESTORE_FIXTURE=JSON.stringify(fixture);const restored=(await command(process.execPath,['scripts/restore-coordinated-backup.mjs',backup.artifact])).toString().trim().split('\n').map(line=>JSON.parse(line));assert.equal(restored[0].calendarVerified,true);assert.equal(restored[0].calendarApiVerified,true);assert.equal(restored[0].reminderMetadataVerified,true);assert.equal(restored[0].reminderApiVerified,true);assert.equal(restored[1].cleanupComplete,true);for(const row of restored)console.log(JSON.stringify(row));
  const key=await readFile('.data/backup-keys/local-core.key'),encrypted=await readFile(backup.artifact,'utf8'),decrypted=await compactDecrypt(encrypted,key);const broken=JSON.parse(Buffer.from(decrypted.plaintext).toString());broken.calendar.meeting_reminders.sha256='0'.repeat(64);
  negative=`.data/backups/calendar-mismatch-${randomUUID()}.jwe`;const changed=await new CompactEncrypt(Buffer.from(JSON.stringify(broken))).setProtectedHeader({alg:'dir',enc:'A256GCM',cty:'application/concord-backup+json'}).encrypt(key);await writeFile(negative,changed,{flag:'wx',mode:0o600});
  let failed;try{await command(process.execPath,['scripts/restore-coordinated-backup.mjs',negative]);}catch(e){failed=e;}assert.ok(failed);assert.match(failed.message,/Restored calendar digest mismatch/);assert.ok(failed.stdout.includes('"cleanupComplete":true'));console.log(JSON.stringify({reminderDigestMismatchRejected:true,failureCleanupComplete:true,sourceCancellationDidNotAlterSnapshot:true,fixtureSeries:made.seriesId}));
}finally{
  if(dueMeeting)await call(alice,`/v1/organizations/${org}/meetings/${dueMeeting}`,'PATCH',{cancelled:true}).catch(()=>{});
  if(first)await call(alice,`/v1/organizations/${org}/meetings/${first}/series`,'PATCH',{cancelled:true}).catch(()=>{});await pool.query('UPDATE memberships SET active=false WHERE org_id=$1',[org]);await pool.end();delete process.env.CALENDAR_RESTORE_FIXTURE;if(negative)await unlink(negative).catch(()=>{});
}
