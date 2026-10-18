import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {readFile,writeFile,readdir,rm,mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {CompactEncrypt} from 'jose';
import {command,sha} from './backup-common.mjs';
import {decryptBackup,immutableBackupDigest} from './scanner-refresh.mjs';
if(process.env.ALLOW_LOCAL_BACKUP!=='true')throw new Error('Explicit local recovery opt-in required');
const [originArg,parentArg]=process.argv.slice(2);if(!originArg||!parentArg)throw new Error('Usage: test-scanner-refresh.mjs ORIGINAL_V10 REFRESHED_V11');
const originPath=path.resolve(originArg),parentPath=path.resolve(parentArg),key=await readFile('.data/backup-keys/local-core.key');
const originText=await readFile(originPath,'utf8'),parentText=await readFile(parentPath,'utf8'),origin=await decryptBackup(originText,key),parent=await decryptBackup(parentText,key);
assert.equal(origin.version,10);assert.equal(parent.version,11);assert.equal(parent.scannerRefresh.originEnvelope,originText);assert.equal(immutableBackupDigest(parent),immutableBackupDigest(origin));
const realDocker=(await command('which',['docker'])).toString().trim(),directory=await mkdtemp(path.join(tmpdir(),'concord-refresh-drill-')),log=path.join(directory,'guard.log'),negative=[];
const digestFile=async target=>{const hash=createHash('sha256');for await(const chunk of createReadStream(target))hash.update(chunk);return hash.digest('hex');};
const originals=[originPath,path.join(path.dirname(originPath),origin.imageArchive.name),parentPath,path.join(path.dirname(parentPath),parent.imageArchive.name)];
const sourceDigests=await Promise.all(originals.map(digestFile));
const primary=async()=>JSON.parse(await command(realDocker,['inspect','concord-collaboration-api-1','concord-collaboration-postgres-1','concord-collaboration-object-store-1','concord-collaboration-clamav-1'])).map(c=>[c.Id,c.Image]);
const inventory=async()=>({containers:(await command(realDocker,['ps','-a','--format','{{.Names}}'])).toString().split('\n').filter(n=>/^concord-(restore|scanner-capture)-/.test(n)).sort(),volumes:(await command(realDocker,['volume','ls','--filter','name=concord-restore-','--format','{{.Name}}'])).toString(),networks:(await command(realDocker,['network','ls','--filter','name=concord-restore-','--format','{{.Name}}'])).toString(),tags:(await command(realDocker,['image','ls','--format','{{.Repository}}:{{.Tag}}'])).toString().split('\n').filter(n=>/^concord-(backup-|scanner-snapshot:)/.test(n)).sort(),artifacts:(await readdir(path.dirname(parentPath))).filter(n=>n.startsWith('core-')||n.startsWith('.scanner-refresh-')).sort(),temporary:(await readdir(tmpdir())).filter(n=>/^concord-(scanner-capture|images|recovery-kit)-/.test(n)).sort()});
const guarded=async(mode,args)=>{
  const saved={PATH:process.env.PATH,REFRESH_MODE:process.env.REFRESH_MODE,REFRESH_DOCKER:process.env.REFRESH_DOCKER,REFRESH_OLD:process.env.REFRESH_OLD,REFRESH_LOG:process.env.REFRESH_LOG};
  await writeFile(log,'');try{Object.assign(process.env,{PATH:directory+path.delimiter+saved.PATH,REFRESH_MODE:mode,REFRESH_DOCKER:realDocker,REFRESH_OLD:JSON.stringify([origin.images.scanner,parent.images.scanner]),REFRESH_LOG:log});return await command(process.execPath,args);}
  finally{for(const [name,value] of Object.entries(saved)){if(value===undefined)delete process.env[name];else process.env[name]=value;}}
};
try{
  await writeFile(path.join(directory,'docker'),`#!/usr/bin/env node
const {spawn}=require('node:child_process'),{appendFileSync}=require('node:fs'),args=process.argv.slice(2);
const old=JSON.parse(process.env.REFRESH_OLD),mode=process.env.REFRESH_MODE;
if(mode==='no-docker'||(['run','create','start'].includes(args[0])&&args.some(a=>old.includes(a)))){appendFileSync(process.env.REFRESH_LOG,'blocked\\n');console.error('Parent scanner startup or premature Docker call forbidden');process.exit(91);}
if(mode==='fail-candidate'&&args[0]==='run'&&args.some(a=>/^concord-restore-.*-scanner$/.test(a))){appendFileSync(process.env.REFRESH_LOG,'candidate-failure\\n');console.error('Injected candidate scanner startup failure');process.exit(92);}
const child=spawn(process.env.REFRESH_DOCKER,args,{stdio:'inherit'});child.on('error',e=>{console.error(e.message);process.exitCode=1;});child.on('close',code=>{process.exitCode=code??1;});
`,{flag:'wx',mode:0o700});
  const before=await primary();let baseline=await inventory();
  for(const [name,edit] of [
    ['data-image',d=>{d.images.api=d.images.postgres;}],
    ['dump-with-recomputed-checksum',d=>{const bytes=Buffer.concat([Buffer.from(d.database,'base64'),Buffer.from('changed')]);d.database=bytes.toString('base64');d.databaseSha=sha(bytes);} ],
    ['snapshot-time',d=>{d.snapshotAt='2020-01-01T00:00:00.000Z';}],
    ['origin-ciphertext',d=>{d.scannerRefresh.originEnvelope=d.scannerRefresh.originEnvelope.slice(0,-1)+'!';d.scannerRefresh.originSha256=sha(d.scannerRefresh.originEnvelope);}]
  ]){
    const broken=structuredClone(parent);edit(broken);const target=path.join(path.dirname(parentPath),'refresh-negative-'+randomUUID()+'.jwe');negative.push(target);await writeFile(target,await new CompactEncrypt(Buffer.from(JSON.stringify(broken))).setProtectedHeader({alg:'dir',enc:'A256GCM',cty:'application/concord-backup+json'}).encrypt(key),{mode:0o600,flag:'wx'});
    await assert.rejects(guarded('no-docker',['scripts/restore-coordinated-backup.mjs',target]),/immutable backup data|JWE|decryption|base64url/i);
    assert.equal(await readFile(log,'utf8'),'');console.log(JSON.stringify({refreshTamperRejectedBeforeDocker:name}));
  }
  assert.deepEqual(await inventory(),baseline);
  const receipt=JSON.parse((await guarded('old-scanner-forbidden',['scripts/refresh-backup-scanner.mjs',parentPath])).toString());
  assert.equal(await readFile(log,'utf8'),'');assert.equal(receipt.candidateRestoreVerified,true);assert.equal(receipt.scannerRefreshVerified,true);assert.equal(receipt.scannerChanged,true);
  const repeated=await decryptBackup(await readFile(receipt.artifact,'utf8'),key);
  assert.equal(repeated.scannerRefresh.originEnvelope,originText);assert.equal(repeated.scannerRefresh.previousArtifactSha256,sha(parentText));assert.equal(repeated.scannerRefresh.previousScannerImage,parent.images.scanner);assert.equal(immutableBackupDigest(repeated),immutableBackupDigest(origin));assert.deepEqual(await primary(),before);
  console.log(JSON.stringify({repeatedRefresh:receipt,originalOriginRetained:true,parentScannerStarts:0,primaryIdsAndImagesUnchanged:true}));
  baseline=await inventory();
  await assert.rejects(guarded('fail-candidate',['scripts/refresh-backup-scanner.mjs',parentPath]),/Injected candidate scanner startup failure/);
  assert.equal(await readFile(log,'utf8'),'candidate-failure\n');assert.deepEqual(await inventory(),baseline);assert.deepEqual(await primary(),before);
  assert.deepEqual(await Promise.all(originals.map(digestFile)),sourceDigests);
  console.log(JSON.stringify({candidateFailureRejected:true,noCandidateOrPairPublished:true,capturePinsAndRestoreResourcesCleaned:true,originalPairsByteIdentical:true,primaryIdsAndImagesUnchanged:true}));
}finally{for(const target of negative)await rm(target,{force:true});await rm(directory,{recursive:true,force:true});}
