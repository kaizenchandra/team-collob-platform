import {verifyScannerRefresh} from './scanner-refresh.mjs';
import {compactDecrypt} from 'jose';
import {validateBackup,maxBytes} from './backup-common.mjs';
import {authenticate,digest} from './run-recovery-kit.mjs';
import {readFile,mkdir,readdir,lstat,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
const [artifactArg,destinationArg,keyArg='.data/backup-keys/local-core.key']=process.argv.slice(2);
if(process.env.ALLOW_LOCAL_BACKUP!=='true')throw new Error('Explicit local backup opt-in required');
if(!artifactArg||!destinationArg)throw new Error('Usage: export-recovery-kit.mjs BACKUP NEW_DIRECTORY [KEY]');
const artifact=path.resolve(artifactArg),destination=path.resolve(destinationArg),key=await readFile(keyArg);
if((await lstat(artifact)).size>maxBytes*2)throw new Error('Backup too large');
const encrypted=await readFile(artifact);
const decrypted=await compactDecrypt(encrypted.toString(),key,{keyManagementAlgorithms:['dir'],contentEncryptionAlgorithms:['A256GCM']});
if(decrypted.plaintext.length>maxBytes||decrypted.protectedHeader.cty!=='application/concord-backup+json')throw new Error('Invalid backup envelope');
await verifyScannerRefresh(validateBackup(JSON.parse(Buffer.from(decrypted.plaintext).toString())),key);
await mkdir(destination,{mode:0o700});
try{
  const files=[];let total=0;
  async function copy(relative){
    const stat=await lstat(relative);if(stat.isSymbolicLink())throw new Error('Linked kit source rejected');
    if(stat.isDirectory()){for(const child of (await readdir(relative)).sort())await copy(relative+'/'+child);return;}
    if(!stat.isFile()||stat.size>8*1024*1024||(total+=stat.size)>64*1024*1024||files.length>=5000)throw new Error('Kit source limit exceeded');
    const bytes=await readFile(relative),target=path.join(destination,relative);await mkdir(path.dirname(target),{recursive:true,mode:0o700});await writeFile(target,bytes,{flag:'wx',mode:0o600});files.push({path:relative,bytes:bytes.length,sha256:digest(bytes)});
  }
  for(const name of ['restore-coordinated-backup','capture-scanner','scanner-refresh','scanner-refresh-contract','scanner-contract','restore-transfer','backup-common','image-archive','image-archive-contract','file-retention-backup','image-fixture','retention-backup','preservation-backup','calendar-backup','moderation-backup'])await copy(`scripts/${name}.mjs`);
  for(const relative of ['infra/seaweedfs/local-s3.json','node_modules/jose','node_modules/zod'])await copy(relative);
  const pkg=Buffer.from('{"type":"module","private":true}\n');await writeFile(path.join(destination,'package.json'),pkg,{mode:0o600,flag:'wx'});files.push({path:'package.json',bytes:pkg.length,sha256:digest(pkg)});
  const raw=Buffer.from(JSON.stringify({version:1,artifactSha256:digest(encrypted),files}));
  await writeFile(path.join(destination,'manifest.json'),raw,{mode:0o600,flag:'wx'});await writeFile(path.join(destination,'manifest.hmac'),authenticate(raw,key),{mode:0o600,flag:'wx'});
  const launcher=await readFile('scripts/run-recovery-kit.mjs');await writeFile(path.join(destination,'run-recovery-kit.mjs'),launcher,{mode:0o600,flag:'wx'});
  console.log(JSON.stringify({directory:destination,files:files.length,bytes:total+pkg.length,launcherSha256:digest(launcher),keyIncluded:false}));
}catch(error){await rm(destination,{recursive:true,force:true});throw error;}
