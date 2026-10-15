import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateBackup,sha} from '../scripts/backup-common.mjs';
const image='sha256:'+'a'.repeat(64),id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const fixture=()=>({version:1,snapshotAt:new Date().toISOString(),images:{api:image,postgres:image,objects:image},counts:{files:1},database:Buffer.from('dump').toString('base64'),databaseSha:sha('dump'),files:[{id,org_id:id,channel_id:id,storage_key:id,bytes:5,sha256:sha('bytes'),storage_backend:'local',object_key:null,object_bucket:null,state:'quarantined',data:Buffer.from('bytes').toString('base64')}]});
test('backup validation rejects missing, corrupt, duplicate and unsafe-path file data',()=>{
  assert.equal(validateBackup(fixture()).files.length,1);
  for(const edit of [x=>{x.files=[];},x=>{x.files[0].data='YQ==';},x=>{x.databaseSha=sha('wrong');},x=>{x.files[0].storage_key='../escape';},x=>{x.files.push(x.files[0]);x.counts.files=2;}]){const value=fixture();edit(value);assert.throws(()=>validateBackup(value));}
});

test('version2 backups require valid scoped lineages and unique revision ordinals',()=>{
  const value=fixture();value.version=2;
  assert.throws(()=>validateBackup(value),/Missing revision metadata/);
  Object.assign(value.files[0],{revision_root:null,revision_number:1});
  const child={...value.files[0],id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',revision_root:id,revision_number:2};value.files.push(child);value.counts.files=2;
  assert.equal(validateBackup(value).files[1].revision_number,2);
  for(const edit of [x=>{x.files[1].revision_root=child.id;},x=>{x.files[1].channel_id=child.id;},x=>{x.files[1].org_id=child.id;},x=>{x.files[1].revision_root='cccccccc-cccc-4ccc-8ccc-cccccccccccc';},x=>{x.files[0].revision_number=2;},x=>{x.files[0].state='deleted';},x=>{x.files.push({...x.files[1],id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc'});x.counts.files=3;}]){const broken=structuredClone(value);edit(broken);assert.throws(()=>validateBackup(broken));}
  const legacy=fixture();assert.equal(validateBackup(legacy).version,1);assert.equal(validateBackup(legacy).files[0].revision_number,undefined);
});

test('version3 calendar manifests require complete bounded counts and digests',()=>{
  const value=fixture();value.version=3;Object.assign(value.files[0],{revision_root:null,revision_number:1});
  assert.throws(()=>validateBackup(value),/Missing calendar manifest/);
  value.calendar=Object.fromEntries(['meetings','meeting_series','meeting_attendees','calendar_versions'].map(t=>{value.counts[t]=0;return [t,{count:0,sha256:sha('')}];}));assert.equal(validateBackup(value).version,3);
  for(const edit of [x=>{delete x.calendar.meetings;},x=>{x.calendar.meetings.sha256='invalid';},x=>{x.calendar.meetings.count=50001;},x=>{x.counts.meetings=1;}]){const bad=structuredClone(value);edit(bad);assert.throws(()=>validateBackup(bad));}
  const legacy=fixture();legacy.version=2;Object.assign(legacy.files[0],{revision_root:null,revision_number:1});assert.equal(validateBackup(legacy).calendar,undefined);
});

test('version4 requires reminder count and digest while version3 keeps its original scope',()=>{
  const value=fixture();value.version=4;Object.assign(value.files[0],{revision_root:null,revision_number:1});value.calendar=Object.fromEntries(['meetings','meeting_series','meeting_attendees','calendar_versions','meeting_reminders'].map(t=>{value.counts[t]=0;return [t,{count:0,sha256:sha('')}];}));assert.equal(validateBackup(value).version,4);
  for(const edit of [x=>{delete x.calendar.meeting_reminders;},x=>{x.calendar.meeting_reminders.sha256='invalid';},x=>{x.calendar.meeting_reminders.count=50001;},x=>{x.counts.meeting_reminders=1;},x=>{x.version=3;}]){const bad=structuredClone(value);edit(bad);assert.throws(()=>validateBackup(bad));}
  const legacy=structuredClone(value);legacy.version=3;delete legacy.calendar.meeting_reminders;delete legacy.counts.meeting_reminders;assert.equal(validateBackup(legacy).version,3);
});

test('version5 requires a complete bounded moderation manifest and preserves legacy scope',()=>{
  const value=fixture();value.version=5;Object.assign(value.files[0],{revision_root:null,revision_number:1});value.calendar=Object.fromEntries(['meetings','meeting_series','meeting_attendees','calendar_versions','meeting_reminders'].map(t=>{value.counts[t]=0;return [t,{count:0,sha256:sha('')}];}));value.moderation=Object.fromEntries(['channels','channel_members','team_members','memberships','messages','message_mentions','message_reports','audit','outbox'].map(t=>{value.counts[t]=0;return [t,{count:0,sha256:sha('')}];}));assert.equal(validateBackup(value).version,5);
  for(const edit of [x=>{delete x.moderation;},x=>{delete x.moderation.message_reports;},x=>{x.moderation.channels.sha256='invalid';},x=>{x.moderation.audit.count=50001;},x=>{x.counts.message_reports=1;},x=>{delete x.calendar.meeting_reminders;},x=>{x.version=4;}]){const bad=structuredClone(value);edit(bad);assert.throws(()=>validateBackup(bad));}
  const legacy=structuredClone(value);legacy.version=4;delete legacy.moderation;assert.equal(validateBackup(legacy).version,4);
});
