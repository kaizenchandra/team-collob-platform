import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {CompactEncrypt} from 'jose';
import {command,sha} from './backup-common.mjs';
import {decryptBackup} from './scanner-refresh.mjs';
import {imageFileDigest} from './image-archive.mjs';
if(process.env.ALLOW_LOCAL_BACKUP!=='true')throw new Error('Explicit local backup preflight opt-in required');
const artifacts=process.argv.slice(2);if(!artifacts.length)throw new Error('Pass at least one genuine backup');
const directory=await mkdtemp(path.join(tmpdir(),'concord-preflight-drill-')),log=path.join(directory,'docker.log'),keyFile=path.resolve('.data/backup-keys/local-core.key'),key=await readFile(keyFile),negative=[];
const baseline=(await readdir(tmpdir())).filter(n=>/^concord-(images|recovery-kit)-/.test(n)).sort();
async function guarded(target){
  const saved={PATH:process.env.PATH,TMPDIR:process.env.TMPDIR,PREFLIGHT_DOCKER_LOG:process.env.PREFLIGHT_DOCKER_LOG};
  try{Object.assign(process.env,{PATH:directory+path.delimiter+saved.PATH,TMPDIR:path.join(directory,'not-a-directory'),PREFLIGHT_DOCKER_LOG:log});return await command(process.execPath,['scripts/verify-backup.mjs',target,keyFile]);}
  finally{for(const [name,value] of Object.entries(saved)){if(value===undefined)delete process.env[name];else process.env[name]=value;}}
}
try{
  await writeFile(log,'');await writeFile(path.join(directory,'not-a-directory'),'No plaintext staging allowed');
  await writeFile(path.join(directory,'docker'),`#!/usr/bin/env node
require('node:fs').appendFileSync(process.env.PREFLIGHT_DOCKER_LOG,'forbidden\\n');console.error('Docker forbidden in preflight');process.exit(91);
`,{mode:0o700,flag:'wx'});
  for(const target of artifacts){
    const ciphertext=await readFile(target),data=await decryptBackup(ciphertext.toString(),key),companion=data.imageArchive&&path.join(path.dirname(target),data.imageArchive.name),before=companion&&await imageFileDigest(companion);
    const result=JSON.parse((await guarded(target)).toString());assert.equal(result.envelopeVerified,true);assert.equal(result.imageArchiveVerified,data.version>=8);assert.equal(result.scannerRefreshVerified,data.version===11);assert.equal(result.restoreVerified,false);assert.equal(result.scannerRuntimeVerified,false);assert.equal(result.sha256,sha(ciphertext));assert.equal(result.fileBytesVerified,data.files.length);assert.ok(!('database' in result));assert.ok(!('files' in result));
    assert.equal(sha(await readFile(target)),sha(ciphertext));if(companion)assert.deepEqual(await imageFileDigest(companion),before);console.log(JSON.stringify({...result,dockerForbidden:true,plaintextStagingUnavailable:true,originalPairUnchanged:true}));
    if(data.version===10){
      const broken={...data,images:{...data.images,scanner:data.images.api}},bad=path.join(path.dirname(target),'preflight-negative-'+randomUUID()+'.jwe');negative.push(bad);
      await writeFile(bad,await new CompactEncrypt(Buffer.from(JSON.stringify(broken))).setProtectedHeader({alg:'dir',enc:'A256GCM',cty:'application/concord-backup+json'}).encrypt(key),{mode:0o600,flag:'wx'});
      await assert.rejects(guarded(bad),/Image archive authentication failed/);console.log(JSON.stringify({validEnvelopeWrongCompanionRoleRejected:true,dockerForbidden:true}));
    }
  }
  assert.equal(await readFile(log,'utf8'),'');assert.deepEqual((await readdir(tmpdir())).filter(n=>/^concord-(images|recovery-kit)-/.test(n)).sort(),baseline);
  console.log(JSON.stringify({dockerCalls:0,noPlaintextStaging:true,originalPairsUnchanged:true}));
}finally{for(const target of negative)await rm(target,{force:true});await rm(directory,{recursive:true,force:true});}
