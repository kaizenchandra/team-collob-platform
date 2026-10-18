import {CompactEncrypt} from 'jose';
import {randomUUID} from 'node:crypto';
import {open,writeFile,rm,link} from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {command,maxBytes,sha,validateBackup} from './backup-common.mjs';
import {captureScanner} from './capture-scanner.mjs';
import {prepareImages,exportImageArchive} from './image-archive.mjs';
import {decryptBackup,createScannerRefreshProof,verifyScannerRefresh,immutableBackupDigest} from './scanner-refresh.mjs';
if(process.env.ALLOW_LOCAL_BACKUP!=='true')throw new Error('Explicit local scanner refresh opt-in required');
const [parentArg,keyArg=process.env.CONCORD_BACKUP_KEY_FILE||'.data/backup-keys/local-core.key']=process.argv.slice(2);
if(!parentArg)throw new Error('Usage: refresh-backup-scanner.mjs BACKUP [KEY]');
const parent=path.resolve(parentArg),keyPath=path.resolve(keyArg);let key;
const keyHandle=await open(keyPath,constants.O_RDONLY|constants.O_NOFOLLOW);try{const info=await keyHandle.stat();if(!info.isFile()||info.size!==32||(info.mode&0o077)!==0)throw new Error('Backup key must be32bytes and private');key=await keyHandle.readFile();if(key.length!==32)throw new Error('Backup key changed');}finally{await keyHandle.close();}
const source=await open(parent,constants.O_RDONLY|constants.O_NOFOLLOW);let encrypted;
try{const info=await source.stat();if(!info.isFile()||info.size>maxBytes*2)throw new Error('Invalid parent backup');encrypted=await source.readFile('utf8');}finally{await source.close();}
const backup=await decryptBackup(encrypted,key),proof=await createScannerRefreshProof(encrypted,key),directory=path.dirname(parent),id=randomUUID(),artifact=path.join(directory,'core-'+id+'.jwe'),candidate=path.join(directory,'.scanner-refresh-'+id+'.jwe'),pins={};
let capture,companion,published=false;const started=Date.now();
try{
  // Authenticate original image bytes and cache exact IDs; never start its scanner.
  await prepareImages({directory,descriptor:backup.imageArchive,images:backup.images,key});
  capture=await captureScanner(id);const images={...backup.images,scanner:capture.image};
  for(const [role,image] of Object.entries(images)){const tag=`concord-backup-${role}:${id}`;await command('docker',['image','tag',image,tag]);pins[role]=tag;}
  companion=await exportImageArchive({directory,name:'core-images-'+id+'.bin',images,key});
  const refreshed=validateBackup({...backup,version:11,images,scanner:capture.manifest,imageArchive:companion,scannerRefresh:proof});
  await verifyScannerRefresh(refreshed,key);
  if(immutableBackupDigest(refreshed)!==immutableBackupDigest(backup))throw new Error('Scanner refresh changed immutable backup data');
  const plaintext=Buffer.from(JSON.stringify(refreshed));if(plaintext.length>maxBytes)throw new Error('Refreshed backup exceeds local limit');
  const output=await new CompactEncrypt(plaintext).setProtectedHeader({alg:'dir',enc:'A256GCM',cty:'application/concord-backup+json'}).encrypt(key);
  await writeFile(candidate,output,{flag:'wx',mode:0o600});const handle=await open(candidate,'r');try{await handle.sync();}finally{await handle.close();}
  const previousKey=process.env.CONCORD_BACKUP_KEY_FILE;let verification;
  try{process.env.CONCORD_BACKUP_KEY_FILE=keyPath;verification=(await command(process.execPath,['scripts/restore-coordinated-backup.mjs',candidate])).toString().trim().split('\n').map(JSON.parse);}
  finally{if(previousKey===undefined)delete process.env.CONCORD_BACKUP_KEY_FILE;else process.env.CONCORD_BACKUP_KEY_FILE=previousKey;}
  if(!verification[0]?.scannerVerified||!verification[0]?.scannerRefreshVerified||!verification[0]?.countsMatch||!verification[1]?.cleanupComplete)throw new Error('Scanner refresh candidate verification failed');
  // Exclusive atomic publication only after authenticated origin/data checks and complete real restore.
  await link(candidate,artifact);published=true;
  console.log(JSON.stringify({artifact,imageArchive:companion,imagePins:pins,parentSha256:sha(encrypted),originSha256:proof.originSha256,sha256:sha(output),snapshotAt:refreshed.snapshotAt,dataUnchanged:true,dataImageIdsUnchanged:true,scannerChanged:images.scanner!==backup.images.scanner,scannerVersion:verification[0].scannerVersion,scannerRefreshVerified:true,candidateRestoreVerified:true,verification:verification[0],durationMs:Date.now()-started}));
}finally{
  await rm(candidate,{force:true});
  if(!published){if(companion)await rm(path.join(directory,companion.name),{force:true});for(const tag of Object.values(pins))await command('docker',['image','rm',tag]).catch(()=>{});}
  if(capture)await command('docker',['image','rm',capture.tag]).catch(()=>{});
}
