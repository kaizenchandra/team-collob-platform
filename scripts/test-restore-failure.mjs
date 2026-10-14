import {readFile,writeFile,unlink} from 'node:fs/promises';
import {CompactEncrypt,compactDecrypt} from 'jose';
import assert from 'node:assert/strict';
import {command} from './backup-common.mjs';
if(process.env.ALLOW_LOCAL_BACKUP!=='true')throw new Error('Explicit local failure exercise opt-in required');
const artifact=process.argv[2],key=await readFile('.data/backup-keys/local-core.key');
const original=await compactDecrypt(await readFile(artifact,'utf8'),key);
const payload=JSON.parse(Buffer.from(original.plaintext).toString());
const revisionMode=process.argv[3]==='--revision';
if(revisionMode){
  assert.equal(payload.version,2);
  const child=payload.files.find(f=>f.revision_root);assert.ok(child,'A revision fixture is required');
  const occupied=new Set(payload.files.filter(f=>f.revision_root===child.revision_root).map(f=>f.revision_number));
  const ordinal=Array.from({length:99},(_,i)=>i+2).find(n=>!occupied.has(n));assert.ok(ordinal,'An unused ordinal is required');child.revision_number=ordinal;
}else payload.counts.messages++;
const invalid=await new CompactEncrypt(Buffer.from(JSON.stringify(payload))).setProtectedHeader({alg:'dir',enc:'A256GCM',cty:'application/concord-backup+json'}).encrypt(key);
const testArtifact=artifact+(revisionMode?'.inconsistent-revision':'.inconsistent');
try{
  await writeFile(testArtifact,invalid,{mode:0o600,flag:'wx'});
  let failure;try{await command(process.execPath,['scripts/restore-coordinated-backup.mjs',testArtifact]);}catch(e){failure=e;}
  assert.ok(failure,'Inconsistent restored database must fail verification');
  if(revisionMode)assert.match(failure.message,/Manifest\/database mismatch/);
  const cleanup=JSON.parse(failure.stdout.trim());assert.equal(cleanup.cleanupComplete,true);assert.deepEqual(cleanup.remainingExerciseResources,[]);
  console.log(JSON.stringify({inconsistentManifestRejected:true,revisionMode,postCreationFailureCleanedAllResources:true}));
}finally{await unlink(testArtifact).catch(()=>{});}
