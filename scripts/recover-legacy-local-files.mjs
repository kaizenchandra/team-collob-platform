import {readFile} from 'node:fs/promises';
import {command,sha} from './backup-common.mjs';
if(process.env.ALLOW_LOCAL_BACKUP!=='true')throw new Error('Explicit local recovery opt-in required');
const inspect=JSON.parse((await command('docker',['inspect','concord-collaboration-api-1'])).toString())[0];
if(!inspect.Config.Env.includes('NODE_ENV=development'))throw new Error('Local development only');
const query=`import {pool} from './services/core/db.ts';import {lstat} from 'node:fs/promises';import {fileRoot} from './services/core/file-content.ts';import path from 'node:path';const missing=[];for(const f of (await pool.query("SELECT id,storage_key,bytes,sha256 FROM files WHERE storage_backend='local'")).rows){try{await lstat(path.join(fileRoot(),f.storage_key));}catch(e){if(e.code!=='ENOENT')throw e;missing.push(f);}}console.log(JSON.stringify(missing));await pool.end();`;
const missing=JSON.parse((await command('docker',['exec','concord-collaboration-api-1','node','--input-type=module','-e',query])).toString());
let restored=0,unresolved=0;
for(const f of missing){
  if(!/^[a-f0-9-]{36}$/.test(f.storage_key))throw new Error('Invalid legacy key');
  let bytes;try{bytes=await readFile(`.data/files/${f.storage_key}`);}catch{unresolved++;continue;}
  if(bytes.length!==Number(f.bytes)||sha(bytes)!==f.sha256){unresolved++;continue;}
  const restore=`import {open} from 'node:fs/promises';import path from 'node:path';import {fileRoot} from './services/core/file-content.ts';import {pool} from './services/core/db.ts';import {createHash} from 'node:crypto';const chunks=[];for await(const b of process.stdin)chunks.push(b);const bytes=Buffer.concat(chunks);const f=(await pool.query("SELECT * FROM files WHERE id=$1 AND storage_backend='local'",[${JSON.stringify(f.id)}])).rows[0];if(!f||bytes.length!==Number(f.bytes)||createHash('sha256').update(bytes).digest('hex')!==f.sha256)throw new Error('Recovery validation failed');const out=await open(path.join(fileRoot(),f.storage_key),'wx',0o600);try{await out.writeFile(bytes);await out.sync();}finally{await out.close();}await pool.query("INSERT INTO audit(org_id,action,target,metadata) VALUES($1,'file.bytes_restored',$2,$3)",[f.org_id,f.id,{source:'verified_legacy_host_copy'}]);await pool.end();`;
  await command('docker',['exec','-i','concord-collaboration-api-1','node','--input-type=module','-e',restore],bytes);restored++;
}
console.log(JSON.stringify({missing:missing.length,restored,unresolved}));if(unresolved)process.exitCode=1;
