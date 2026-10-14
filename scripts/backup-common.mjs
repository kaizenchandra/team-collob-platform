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
const file=z.object({id:z.uuid(),org_id:z.uuid(),channel_id:z.uuid(),storage_key:z.uuid(),bytes:z.coerce.number().int().min(0).max(1048576),sha256:z.string().regex(/^[a-f0-9]{64}$/),storage_backend:z.enum(['local','s3']),object_key:z.string().nullable(),object_bucket:z.string().nullable(),state:z.string(),revision_root:z.uuid().nullable().optional(),revision_number:z.number().int().min(1).max(100).optional(),data:z.string().max(1400000)});
export const envelope=z.object({version:z.union([z.literal(1),z.literal(2)]),snapshotAt:z.iso.datetime(),images:z.object({api:z.string().regex(/^sha256:[a-f0-9]{64}$/),postgres:z.string().regex(/^sha256:[a-f0-9]{64}$/),objects:z.string().regex(/^sha256:[a-f0-9]{64}$/)}),counts:z.record(z.string(),z.number().int().nonnegative()),database:z.string().max(maxBytes),databaseSha:z.string(),files:z.array(file).max(10000)});
export function validateBackup(value){
  const parsed=envelope.parse(value),dump=Buffer.from(parsed.database,'base64');
  if(sha(dump)!==parsed.databaseSha)throw new Error('Database archive integrity failed');
  if(parsed.counts.files!==parsed.files.length)throw new Error('Backup file manifest incomplete');
  if(new Set(parsed.files.map(f=>f.id)).size!==parsed.files.length)throw new Error('Duplicate backup file');
  for(const f of parsed.files){const bytes=Buffer.from(f.data,'base64');if(bytes.length!==f.bytes || sha(bytes)!==f.sha256)throw new Error('Backup file integrity failed');}
  if(parsed.version===2){
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
  return parsed;
}
