// Trusted entry point: distribute this file's SHA256 separately from the kit.
import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {constants} from 'node:fs';
import {open,mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
export const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
export const authenticate=(bytes,key)=>createHmac('sha256',key).update('concord-recovery-kit-v1\0').update(bytes).digest();
async function bounded(file,max){
  const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const stat=await handle.stat();if(!stat.isFile()||stat.size>max)throw new Error('Invalid recovery file');return await handle.readFile();}finally{await handle.close();}
}
export async function stageKit(directory,artifact,key){
  if(key.length!==32)throw new Error('Invalid backup key');
  const raw=await bounded(path.join(directory,'manifest.json'),1024*1024);
  const signature=await bounded(path.join(directory,'manifest.hmac'),32);
  if(signature.length!==32||!timingSafeEqual(signature,authenticate(raw,key)))throw new Error('Recovery kit authentication failed');
  const manifest=JSON.parse(raw);
  if(manifest.version!==1||!Array.isArray(manifest.files)||manifest.files.length>5000||manifest.files.length===0)throw new Error('Invalid kit manifest');
  if(digest(await bounded(artifact,128*1024*1024))!==manifest.artifactSha256)throw new Error('Recovery kit backup mismatch');
  const temporary=await mkdtemp(path.join(tmpdir(),'concord-recovery-kit-'));
  try{
    let total=0;const seen=new Set();
    for(const file of manifest.files){
      if(typeof file.path!=='string'||!file.path.split('/').every(p=>/^[A-Za-z0-9_.-]+$/.test(p)&&p!=='.'&&p!=='..')||seen.has(file.path)||!Number.isSafeInteger(file.bytes)||file.bytes<0||file.bytes>8*1024*1024)throw new Error('Invalid kit file entry');
      seen.add(file.path);total+=file.bytes;if(total>64*1024*1024)throw new Error('Recovery kit too large');
      // Walk parents too: O_NOFOLLOW on a leaf alone does not reject linked directories.
      let current=directory;
      for(const part of file.path.split('/').slice(0,-1)){current=path.join(current,part);const handle=await open(current,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_DIRECTORY);await handle.close();}
      const bytes=await bounded(path.join(directory,file.path),file.bytes);
      if(bytes.length!==file.bytes||digest(bytes)!==file.sha256)throw new Error('Recovery kit file integrity failed');
      const target=path.join(temporary,file.path);await mkdir(path.dirname(target),{recursive:true,mode:0o700});await writeFile(target,bytes,{flag:'wx',mode:0o600});
    }
    for(const required of ['scripts/restore-coordinated-backup.mjs','package.json','infra/seaweedfs/local-s3.json'])if(!seen.has(required))throw new Error('Incomplete recovery kit');
    return temporary;
  }catch(error){await rm(temporary,{recursive:true,force:true});throw error;}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  let temporary;
  try{
    if(process.env.ALLOW_LOCAL_BACKUP!=='true')throw new Error('Explicit local restore opt-in required');
    if(process.versions.node.split('.')[0]!=='24')throw new Error('Recovery kit requires Node24');
    const [artifactArg,keyArg]=process.argv.slice(2);if(!artifactArg||!keyArg)throw new Error('Usage: node run-recovery-kit.mjs BACKUP KEY');
    const artifact=path.resolve(artifactArg),keyFile=path.resolve(keyArg);
    temporary=await stageKit(path.dirname(fileURLToPath(import.meta.url)),artifact,await readFile(keyFile));
    const code=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,['scripts/restore-coordinated-backup.mjs',artifact],{cwd:temporary,env:{...process.env,CONCORD_BACKUP_KEY_FILE:keyFile},stdio:'inherit'});child.on('error',reject);child.on('close',(code)=>resolve(code??1));});
    process.exitCode=code;
  }catch(error){console.error(error.message);process.exitCode=1;}finally{if(temporary)await rm(temporary,{recursive:true,force:true});}
}
