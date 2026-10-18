import {scannerRefreshSchema} from './scanner-refresh-contract.mjs';
import {scannerManifestSchema} from './scanner-contract.mjs';
import {imageArchiveSchema} from './image-archive-contract.mjs';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {z} from 'zod';
export const maxBytes=64*1024*1024;
export function command(cmd,args,input,limit=maxBytes){
  return new Promise((resolve,reject)=>{
    const child=spawn(cmd,args,{stdio:['pipe','pipe','pipe']});let out=[],size=0,err=[],errSize=0,failed=false;
    const timer=setTimeout(()=>{failed=true;child.kill('SIGKILL');reject(new Error('Backup command deadline exceeded'));},180000);
    child.on('error',e=>{clearTimeout(timer);reject(e);});
    child.stdin.on('error',()=>{});
    child.stdout.on('data',b=>{size+=b.length;if(size>limit){failed=true;child.kill('SIGKILL');reject(new Error('Backup buffer limit exceeded'));}else out.push(b);});
    child.stderr.on('data',b=>{errSize+=b.length;if(errSize<8192)err.push(b);});
    child.on('close',code=>{clearTimeout(timer);if(failed)return;if(code!==0)reject(Object.assign(new Error(`Backup command ${cmd} failed (${code}): ${Buffer.concat(err).toString().slice(0,1000)}`),{stdout:Buffer.concat(out).toString()}));else resolve(Buffer.concat(out));});
    child.stdin.end(input);
  });
}
export const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const file=z.object({id:z.uuid(),org_id:z.uuid(),channel_id:z.uuid(),storage_key:z.uuid(),bytes:z.coerce.number().int().min(0).max(1048576),sha256:z.string().regex(/^[a-f0-9]{64}$/),storage_backend:z.enum(['local','s3']),object_key:z.string().nullable(),object_bucket:z.string().nullable(),state:z.string(),revision_root:z.uuid().nullable().optional(),revision_number:z.number().int().min(1).max(100).optional(),lifecycle_revision:z.number().int().positive().optional(),data:z.string().max(1400000)});
const moderationManifest=z.object(Object.fromEntries(['channels','channel_members','team_members','memberships','messages','message_mentions','message_reports','audit','outbox'].map(table=>[table,z.object({count:z.number().int().min(0).max(50000),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict()]))).strict();
export const envelope=z.object({version:z.union([z.literal(1),z.literal(2),z.literal(3),z.literal(4),z.literal(5),z.literal(6),z.literal(7),z.literal(8),z.literal(9),z.literal(10),z.literal(11)]),scannerRefresh:scannerRefreshSchema.optional(),scanner:scannerManifestSchema.optional(),imageArchive:imageArchiveSchema.optional(),fileRetention:z.object({channel_file_retention:z.object({count:z.number().int().min(0).max(50000),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict()}).strict().optional(),snapshotAt:z.iso.datetime(),images:z.object({api:z.string().regex(/^sha256:[a-f0-9]{64}$/),postgres:z.string().regex(/^sha256:[a-f0-9]{64}$/),objects:z.string().regex(/^sha256:[a-f0-9]{64}$/),scanner:z.string().regex(/^sha256:[a-f0-9]{64}$/).optional()}),counts:z.record(z.string(),z.number().int().nonnegative()),database:z.string().max(maxBytes),databaseSha:z.string(),files:z.array(file).max(10000),calendar:z.object(Object.fromEntries(['meetings','meeting_series','meeting_attendees','calendar_versions'].map(table=>[table,z.object({count:z.number().int().min(0).max(50000),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict()]))).extend({meeting_reminders:z.object({count:z.number().int().min(0).max(50000),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict().optional()}).strict().optional(),preservation:z.object(Object.fromEntries(['channel_preservation','files','file_scan_jobs'].map(table=>[table,z.object({count:z.number().int().min(0).max(50000),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict()]))).strict().optional(),retention:z.object(Object.fromEntries(['channel_message_retention','message_attachments','reactions','saved_messages','read_positions'].map(table=>[table,z.object({count:z.number().int().min(0).max(50000),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict()]))).strict().optional(),moderation:moderationManifest.optional()});
export function validateBackup(value){
  const parsed=envelope.parse(value),dump=Buffer.from(parsed.database,'base64');
  if(sha(dump)!==parsed.databaseSha)throw new Error('Database archive integrity failed');
  if(parsed.counts.files!==parsed.files.length)throw new Error('Backup file manifest incomplete');
  if(new Set(parsed.files.map(f=>f.id)).size!==parsed.files.length)throw new Error('Duplicate backup file');
  for(const f of parsed.files){const bytes=Buffer.from(f.data,'base64');if(bytes.length!==f.bytes || sha(bytes)!==f.sha256)throw new Error('Backup file integrity failed');}
  if(parsed.version>=2){
    const byId=new Map(parsed.files.map(f=>[f.id,f])),ordinals=new Set();
    for(const f of parsed.files){
      if(f.revision_root===undefined || f.revision_number===undefined)throw new Error('Missing revision metadata');
      const root=f.revision_root===null?f:byId.get(f.revision_root);
      if(!root || root.revision_root!==null || root.org_id!==f.org_id || root.channel_id!==f.channel_id || (f.revision_root===null?f.revision_number!==1:f.revision_number<2) || (root.state==='deleted' && f.state!=='deleted'))throw new Error('Invalid revision lineage');
      const ordinal=root.id+':'+f.revision_number;
      if(ordinals.has(ordinal))throw new Error('Duplicate revision ordinal');
      ordinals.add(ordinal);
    }
  }
  if(parsed.version>=3){
    if(!parsed.calendar)throw new Error('Missing calendar manifest');
    if(parsed.version>=4&&!parsed.calendar.meeting_reminders)throw new Error('Missing reminder manifest');
    if(parsed.version===3&&parsed.calendar.meeting_reminders)throw new Error('Unexpected reminder manifest for version3');
    for(const [table,entry] of Object.entries(parsed.calendar))if(parsed.counts[table]!==entry.count)throw new Error('Calendar count manifest mismatch');
  }
  if(parsed.version>=5){if(!parsed.moderation)throw new Error('Missing moderation manifest');for(const [table,entry] of Object.entries(parsed.moderation))if(parsed.counts[table]!==entry.count)throw new Error('Moderation count manifest mismatch');}
  else if(parsed.moderation)throw new Error('Unexpected moderation manifest for legacy version');
  if(parsed.version>=6){if(!parsed.preservation)throw new Error('Missing preservation manifest');for(const [table,entry] of Object.entries(parsed.preservation))if(parsed.counts[table]!==entry.count)throw new Error('Preservation count manifest mismatch');for(const f of parsed.files)if(f.lifecycle_revision===undefined)throw new Error('Missing file lifecycle revision');}
  else if(parsed.preservation)throw new Error('Unexpected preservation manifest for legacy version');
  if(parsed.version>=7){if(!parsed.retention)throw new Error('Missing retention manifest');for(const [table,entry] of Object.entries(parsed.retention))if(parsed.counts[table]!==entry.count)throw new Error('Retention count manifest mismatch');}
  else if(parsed.retention)throw new Error('Unexpected retention manifest for legacy version');
  if(parsed.version>=8){if(!parsed.imageArchive)throw new Error('Missing portable image archive');}
  else if(parsed.imageArchive)throw new Error('Unexpected portable image archive for legacy version');
  if(parsed.version>=9){if(!parsed.fileRetention)throw new Error('Missing file retention manifest');for(const [table,entry] of Object.entries(parsed.fileRetention))if(parsed.counts[table]!==entry.count)throw new Error('File retention count manifest mismatch');}
  else if(parsed.fileRetention)throw new Error('Unexpected file retention manifest for legacy version');
  if(parsed.version>=10){if(!parsed.scanner||!parsed.images.scanner)throw new Error('Missing captured scanner runtime');}
  else if(parsed.scanner||parsed.images.scanner)throw new Error('Unexpected scanner runtime for legacy version');
  if(parsed.version===11){if(!parsed.scannerRefresh)throw new Error('Missing scanner refresh evidence');}
  else if(parsed.scannerRefresh)throw new Error('Unexpected scanner refresh evidence for original backup');
  return parsed;
}
