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

test('version6 requires preservation/job/file digests and lifecycle revisions without broadening legacy claims',()=>{
  const value=fixture();value.version=6;Object.assign(value.files[0],{revision_root:null,revision_number:1,lifecycle_revision:3});
  value.calendar=Object.fromEntries(['meetings','meeting_series','meeting_attendees','calendar_versions','meeting_reminders'].map(t=>{value.counts[t]=0;return [t,{count:0,sha256:sha('')}];}));
  value.moderation=Object.fromEntries(['channels','channel_members','team_members','memberships','messages','message_mentions','message_reports','audit','outbox'].map(t=>{value.counts[t]=0;return [t,{count:0,sha256:sha('')}];}));
  value.preservation=Object.fromEntries(['channel_preservation','files','file_scan_jobs'].map(t=>{const count=t==='files'?1:0;value.counts[t]=count;return [t,{count,sha256:sha(t)}];}));assert.equal(validateBackup(value).version,6);
  for(const edit of [x=>{delete x.preservation;},x=>{delete x.preservation.channel_preservation;},x=>{x.preservation.file_scan_jobs.sha256='invalid';},x=>{x.preservation.files.count=50001;},x=>{x.counts.channel_preservation=1;},x=>{delete x.files[0].lifecycle_revision;},x=>{x.files[0].lifecycle_revision=0;},x=>{delete x.moderation;},x=>{x.version=5;}]){const bad=structuredClone(value);edit(bad);assert.throws(()=>validateBackup(bad));}
  const legacy=structuredClone(value);legacy.version=5;delete legacy.preservation;delete legacy.files[0].lifecycle_revision;assert.equal(validateBackup(legacy).preservation,undefined);
});

test('version7 requires bounded retention/reference manifests while version6 keeps its recorded scope',()=>{
  const value=fixture();value.version=7;Object.assign(value.files[0],{revision_root:null,revision_number:1,lifecycle_revision:2});
  for(const [field,tables] of Object.entries({calendar:['meetings','meeting_series','meeting_attendees','calendar_versions','meeting_reminders'],moderation:['channels','channel_members','team_members','memberships','messages','message_mentions','message_reports','audit','outbox'],preservation:['channel_preservation','files','file_scan_jobs'],retention:['channel_message_retention','message_attachments','reactions','saved_messages','read_positions']}))value[field]=Object.fromEntries(tables.map(t=>{const count=t==='files'?1:0;value.counts[t]=count;return [t,{count,sha256:sha(t)}];}));
  assert.equal(validateBackup(value).version,7);
  for(const edit of [x=>{delete x.retention;},x=>{delete x.retention.channel_message_retention;},x=>{delete x.retention.read_positions;},x=>{x.retention.reactions.sha256='invalid';},x=>{x.retention.saved_messages.count=50001;},x=>{x.counts.message_attachments=1;},x=>{delete x.preservation;},x=>{x.version=6;},x=>{x.retention.unknown={count:0,sha256:sha('')};}]){const bad=structuredClone(value);edit(bad);assert.throws(()=>validateBackup(bad));}
  const legacy=structuredClone(value);legacy.version=6;delete legacy.retention;assert.equal(validateBackup(legacy).retention,undefined);
});

test('version8 requires a safe bounded authenticated image companion and legacy7 cannot claim one',()=>{
  const value=fixture();value.version=8;Object.assign(value.files[0],{revision_root:null,revision_number:1,lifecycle_revision:1});
  for(const [field,tables] of Object.entries({calendar:['meetings','meeting_series','meeting_attendees','calendar_versions','meeting_reminders'],moderation:['channels','channel_members','team_members','memberships','messages','message_mentions','message_reports','audit','outbox'],preservation:['channel_preservation','files','file_scan_jobs'],retention:['channel_message_retention','message_attachments','reactions','saved_messages','read_positions']}))value[field]=Object.fromEntries(tables.map(t=>{const count=t==='files'?1:0;value.counts[t]=count;return [t,{count,sha256:sha(t)}];}));
  value.imageArchive={format:'aes-256-gcm-v1',name:'core-images-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.bin',bytes:128,sha256:sha('encrypted images')};assert.equal(validateBackup(value).version,8);
  for(const edit of [x=>{delete x.imageArchive;},x=>{x.imageArchive.name='../escape.bin';},x=>{x.imageArchive.name='/absolute.bin';},x=>{x.imageArchive.bytes=4294967297;},x=>{x.imageArchive.bytes=1;},x=>{x.imageArchive.sha256='bad';},x=>{x.imageArchive.format='plaintext';},x=>{x.imageArchive.extra=true;},x=>{delete x.retention;},x=>{x.version=7;}]){const bad=structuredClone(value);edit(bad);assert.throws(()=>validateBackup(bad));}
  const legacy=structuredClone(value);legacy.version=7;delete legacy.imageArchive;assert.equal(validateBackup(legacy).imageArchive,undefined);
});

test('version9 requires file-policy manifest/counts and keeps legacy8 scope explicit',()=>{
  const value=fixture();value.version=9;Object.assign(value.files[0],{revision_root:null,revision_number:1,lifecycle_revision:2});
  for(const [field,tables] of Object.entries({calendar:['meetings','meeting_series','meeting_attendees','calendar_versions','meeting_reminders'],moderation:['channels','channel_members','team_members','memberships','messages','message_mentions','message_reports','audit','outbox'],preservation:['channel_preservation','files','file_scan_jobs'],retention:['channel_message_retention','message_attachments','reactions','saved_messages','read_positions'],fileRetention:['channel_file_retention']}))value[field]=Object.fromEntries(tables.map(table=>{const count=table==='files'?1:0;value.counts[table]=count;return [table,{count,sha256:sha(table)}];}));
  value.imageArchive={format:'aes-256-gcm-v1',name:'core-images-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.bin',bytes:128,sha256:sha('images')};assert.equal(validateBackup(value).version,9);
  for(const edit of [x=>{delete x.fileRetention;},x=>{delete x.fileRetention.channel_file_retention;},x=>{x.fileRetention.channel_file_retention.sha256='invalid';},x=>{x.fileRetention.channel_file_retention.count=50001;},x=>{x.counts.channel_file_retention=1;},x=>{x.fileRetention.extra={count:0,sha256:sha('')};},x=>{delete x.preservation;},x=>{delete x.imageArchive;},x=>{x.version=8;}]){const bad=structuredClone(value);edit(bad);assert.throws(()=>validateBackup(bad));}
  const legacy=structuredClone(value);legacy.version=8;delete legacy.fileRetention;assert.equal(validateBackup(legacy).fileRetention,undefined);
});

test('version10 requires captured scanner image and complete bounded definition manifest, preserving legacy9 scope',()=>{
  const value=fixture();value.version=10;Object.assign(value.files[0],{revision_root:null,revision_number:1,lifecycle_revision:1});
  for(const [field,tables] of Object.entries({calendar:['meetings','meeting_series','meeting_attendees','calendar_versions','meeting_reminders'],moderation:['channels','channel_members','team_members','memberships','messages','message_mentions','message_reports','audit','outbox'],preservation:['channel_preservation','files','file_scan_jobs'],retention:['channel_message_retention','message_attachments','reactions','saved_messages','read_positions'],fileRetention:['channel_file_retention']}))value[field]=Object.fromEntries(tables.map(t=>{const count=t==='files'?1:0;value.counts[t]=count;return [t,{count,sha256:sha(t)}];}));
  value.imageArchive={format:'aes-256-gcm-v1',name:'core-images-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.bin',bytes:128,sha256:sha('images')};value.images.scanner='sha256:'+'b'.repeat(64);value.scanner={sourceImage:image,capturedAt:new Date().toISOString(),files:['main.cvd','daily.cld','bytecode.cvd'].map(name=>({name,bytes:1,sha256:sha(name)}))};assert.equal(validateBackup(value).version,10);
  for(const edit of [x=>{delete x.scanner;},x=>{delete x.images.scanner;},x=>{x.scanner.sourceImage='bad';},x=>{x.scanner.files.pop();},x=>{x.scanner.files[0].name='../main.cvd';},x=>{x.scanner.files.push(x.scanner.files[0]);},x=>{x.scanner.files.push({name:'daily.cvd',bytes:1,sha256:sha('')});},x=>{x.scanner.files[0].bytes=134217729;},x=>{for(const f of x.scanner.files)f.bytes=134217728;},x=>{x.scanner.files[0].sha256='bad';},x=>{x.scanner.extra=true;},x=>{x.images.scanner='latest';},x=>{x.version=9;}]){const bad=structuredClone(value);edit(bad);assert.throws(()=>validateBackup(bad));}
  const legacy=structuredClone(value);legacy.version=9;delete legacy.images.scanner;delete legacy.scanner;assert.equal(validateBackup(legacy).scanner,undefined);
});

test('scanner file verification rejects extra files and altered size or digest',async()=>{
  const {verifyScannerFiles}=await import('../scripts/capture-scanner.mjs');
  const manifest={sourceImage:image,capturedAt:new Date().toISOString(),files:['main.cvd','daily.cld','bytecode.cvd'].map(name=>({name,bytes:1,sha256:sha(name)}))};let fault='';
  const docker=async args=>{if(args[2]==='find')return Buffer.from(manifest.files.map(f=>'/var/lib/clamav/'+f.name).join('\n')+(fault==='extra'?'\n/var/lib/clamav/unexpected.dat':''));if(args[2]==='stat')return Buffer.from(fault==='size'?'2':'1');return Buffer.from((fault==='digest'?sha('wrong'):sha(args.at(-1).split('/').at(-1)))+'  '+args.at(-1));};
  await verifyScannerFiles(docker,'fixture',manifest);for(const value of ['extra','size','digest']){fault=value;await assert.rejects(verifyScannerFiles(docker,'fixture',manifest),/Restored scanner/);}
});

function refreshOrigin(){
  const value=fixture();value.version=10;Object.assign(value.files[0],{revision_root:null,revision_number:1,lifecycle_revision:1});
  for(const [field,tables] of Object.entries({calendar:['meetings','meeting_series','meeting_attendees','calendar_versions','meeting_reminders'],moderation:['channels','channel_members','team_members','memberships','messages','message_mentions','message_reports','audit','outbox'],preservation:['channel_preservation','files','file_scan_jobs'],retention:['channel_message_retention','message_attachments','reactions','saved_messages','read_positions'],fileRetention:['channel_file_retention']}))value[field]=Object.fromEntries(tables.map(t=>{const count=t==='files'?1:0;value.counts[t]=count;return [t,{count,sha256:sha(t)}];}));
  value.imageArchive={format:'aes-256-gcm-v1',name:'core-images-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.bin',bytes:128,sha256:sha('images')};value.images.scanner='sha256:'+'b'.repeat(64);value.scanner={sourceImage:image,capturedAt:new Date().toISOString(),files:['main.cvd','daily.cld','bytecode.cvd'].map(name=>({name,bytes:1,sha256:sha(name)}))};return value;
}
test('version11 requires bounded strict refresh evidence while original10 cannot claim it',()=>{
  const value=refreshOrigin();value.version=11;value.scannerRefresh={originEnvelope:'encrypted',originSha256:sha('encrypted'),previousArtifactSha256:sha('encrypted'),previousScannerImage:value.images.scanner,refreshedAt:new Date().toISOString(),immutableSha256:sha('data')};assert.equal(validateBackup(value).version,11);
  for(const edit of [x=>{delete x.scannerRefresh;},x=>{x.scannerRefresh.originEnvelope='';},x=>{x.scannerRefresh.originSha256='invalid';},x=>{x.scannerRefresh.previousScannerImage='latest';},x=>{x.scannerRefresh.immutableSha256='invalid';},x=>{x.scannerRefresh.extra=true;},x=>{x.version=10;}]){const bad=structuredClone(value);edit(bad);assert.throws(()=>validateBackup(bad));}
});
test('authenticated scanner refresh preserves origin payload across repeats and rejects data/image/origin changes',async()=>{
  const {CompactEncrypt}=await import('jose'),{randomBytes}=await import('node:crypto'),{createScannerRefreshProof,verifyScannerRefresh}=await import('../scripts/scanner-refresh.mjs'),key=randomBytes(32),origin=refreshOrigin();
  const encrypt=(value,k=key)=>new CompactEncrypt(Buffer.from(JSON.stringify(value))).setProtectedHeader({alg:'dir',enc:'A256GCM',cty:'application/concord-backup+json'}).encrypt(k),encrypted=await encrypt(origin);
  const first={...origin,version:11,images:{...origin.images,scanner:'sha256:'+'c'.repeat(64)},scannerRefresh:await createScannerRefreshProof(encrypted,key)};assert.equal(await verifyScannerRefresh(first,key),true);assert.equal(await verifyScannerRefresh(origin,key),false);
  for(const edit of [x=>{x.images.api='sha256:'+'d'.repeat(64);},x=>{x.snapshotAt='2020-01-01T00:00:00.000Z';},x=>{x.database=Buffer.from('other dump').toString('base64');x.databaseSha=sha('other dump');},x=>{x.files[0].data=Buffer.from('other').toString('base64');x.files[0].sha256=sha('other');},x=>{x.files[0].lifecycle_revision++;},x=>{x.counts.messages=1;x.moderation.messages.count=1;},x=>{x.scannerRefresh.originSha256=sha('wrong');},x=>{x.scannerRefresh.previousScannerImage='sha256:'+'d'.repeat(64);}]){const bad=structuredClone(first);edit(bad);await assert.rejects(verifyScannerRefresh(bad,key));}
  await assert.rejects(verifyScannerRefresh(first,randomBytes(32)));
  const repeated={...first,images:{...first.images,scanner:'sha256:'+'e'.repeat(64)},scannerRefresh:await createScannerRefreshProof(await encrypt(first),key)};assert.equal(await verifyScannerRefresh(repeated,key),true);assert.equal(repeated.scannerRefresh.originEnvelope,encrypted);assert.equal(repeated.scannerRefresh.immutableSha256,first.scannerRefresh.immutableSha256);assert.equal(repeated.scannerRefresh.previousScannerImage,first.images.scanner);
  const nested=structuredClone(first);nested.scannerRefresh.originEnvelope=await encrypt(first);nested.scannerRefresh.originSha256=sha(nested.scannerRefresh.originEnvelope);await assert.rejects(verifyScannerRefresh(nested,key),/origin must be version10/);
  const legacy=structuredClone(origin);legacy.version=9;delete legacy.scanner;delete legacy.images.scanner;await assert.rejects(createScannerRefreshProof(await encrypt(legacy),key),/requires version10 or11/);
});
