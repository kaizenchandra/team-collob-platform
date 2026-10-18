import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile,rm,mkdtemp,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {compactDecrypt,CompactEncrypt} from 'jose';
import {command} from './backup-common.mjs';
import {exportImageArchive} from './image-archive.mjs';
if(process.env.ALLOW_LOCAL_BACKUP!=='true')throw new Error('Explicit local recovery opt-in required');
const artifact=process.argv[2];if(!artifact)throw new Error('Pass a genuine version10 backup');
const key=await readFile('.data/backup-keys/local-core.key'),decoded=await compactDecrypt(await readFile(artifact,'utf8'),key),data=JSON.parse(Buffer.from(decoded.plaintext).toString());assert.equal(data.version,10);
let fixtureId='',fixtureTag='',fixtureContainer='';
const negative=[],directory=await mkdtemp(path.join(tmpdir(),'concord-scanner-drill-')),realDocker=(await command('which',['docker'])).toString().trim();
const primary=async()=>JSON.parse(await command(realDocker,['inspect','concord-collaboration-api-1','concord-collaboration-postgres-1','concord-collaboration-object-store-1','concord-collaboration-clamav-1'])).map(c=>[c.Id,c.Image]);
const inventory=async()=>({captures:(await command(realDocker,['ps','-a','--filter','name=concord-scanner-capture-','--format','{{.Names}}'])).toString(),captureImages:(await command(realDocker,['image','ls','--filter','reference=concord-scanner-snapshot:*','--format','{{.ID}}'])).toString(),artifacts:(await readdir('.data/backups')).filter(n=>n.startsWith('core-')).sort(),temporary:(await readdir(tmpdir())).filter(n=>n.startsWith('concord-scanner-capture-')).sort()});
try{
  const before=await primary();
  for(const [name,edit,pattern] of [
    ['definition-hash',d=>{d.scanner.files[0].sha256='0'.repeat(64);},/Restored scanner definition digest mismatch/],
    ['definition-set',d=>{const index=d.scanner.files.findIndex(f=>f.name.endsWith('.sign'));assert.ok(index>=0);d.scanner.files.splice(index,1);},/Restored scanner file set mismatch/],
    ['scanner-image-binding',d=>{d.images.scanner=d.images.api;},/Image archive authentication failed/]
  ]){
    const broken=structuredClone(data);edit(broken);const target=path.join(path.dirname(artifact),'scanner-mismatch-'+randomUUID()+'.jwe');negative.push(target);await writeFile(target,await new CompactEncrypt(Buffer.from(JSON.stringify(broken))).setProtectedHeader({alg:'dir',enc:'A256GCM',cty:'application/concord-backup+json'}).encrypt(key),{mode:0o600,flag:'wx'});
    let failure;try{await command(process.execPath,['scripts/restore-coordinated-backup.mjs',target]);}catch(e){failure=e;}assert.ok(failure);assert.match(failure.message,pattern);assert.ok(failure.stdout.includes('"cleanupComplete":true'));console.log(JSON.stringify({scannerTamperRejected:name,cleanupComplete:true}));
  }
  const baseline=await inventory();
  await writeFile(path.join(directory,'docker'),`#!/usr/bin/env node
const {spawn}=require('node:child_process');const args=process.argv.slice(2);
if(args[0]==='commit'&&args.some(a=>a.includes('concord.scanner-snapshot='))){console.error('Injected scanner capture commit failure');process.exit(92);}
const child=spawn(process.env.SCANNER_REAL_DOCKER,args,{stdio:'inherit'});child.on('error',e=>{console.error(e.message);process.exitCode=1;});child.on('close',code=>{process.exitCode=code??1;});
`,{flag:'wx',mode:0o700});
  const previous={PATH:process.env.PATH,SCANNER_REAL_DOCKER:process.env.SCANNER_REAL_DOCKER};let failure;
  try{process.env.PATH=directory+path.delimiter+previous.PATH;process.env.SCANNER_REAL_DOCKER=realDocker;try{await command(process.execPath,['scripts/coordinated-backup.mjs']);}catch(e){failure=e;}}
  finally{for(const [name,value] of Object.entries(previous)){if(value===undefined)delete process.env[name];else process.env[name]=value;}}
  assert.ok(failure);assert.match(failure.message,/Injected scanner capture commit failure/);assert.deepEqual(await inventory(),baseline);assert.deepEqual(await primary(),before);console.log(JSON.stringify({captureFailureRejected:true,captureResourcesAndPlaintextCleaned:true,noBackupPublished:true,primaryIncludingScannerIdsAndImagesUnchanged:true}));
  const uuid=randomUUID();fixtureContainer='concord-scanner-fixture-'+uuid;fixtureTag='concord-scanner-fixture:'+uuid;
  await command(realDocker,['create','--name',fixtureContainer,data.images.scanner]);fixtureId=(await command(realDocker,['commit','--change','LABEL concord.scanner-fixture='+uuid,fixtureContainer,fixtureTag])).toString().trim();assert.notEqual(fixtureId,data.images.scanner);await command(realDocker,['rm',fixtureContainer]);fixtureContainer='';
  const images={...data.images,scanner:fixtureId},descriptor=await exportImageArchive({directory:path.dirname(artifact),name:'core-images-'+uuid+'.bin',images,key});negative.push(path.join(path.dirname(artifact),descriptor.name));
  const missingArtifact=path.join(path.dirname(artifact),'scanner-missing-'+uuid+'.jwe');negative.push(missingArtifact);await writeFile(missingArtifact,await new CompactEncrypt(Buffer.from(JSON.stringify({...data,images,imageArchive:descriptor}))).setProtectedHeader({alg:'dir',enc:'A256GCM',cty:'application/concord-backup+json'}).encrypt(key),{mode:0o600,flag:'wx'});
  await command(realDocker,['image','rm',fixtureTag]);fixtureTag='';let absent=false;try{await command(realDocker,['image','inspect',fixtureId]);}catch(error){assert.match(error.message,/No such image/);absent=true;}assert.equal(absent,true);console.log(JSON.stringify({disposableScannerImageAbsentBeforeRestore:true}));
  const restored=(await command(process.execPath,['scripts/restore-coordinated-backup.mjs',missingArtifact])).toString().trim().split('\n').map(JSON.parse);assert.equal(restored[0].imagesImported,true);assert.equal(restored[0].scannerVerified,true);assert.equal(restored[0].countsMatch,true);assert.equal(restored[1].cleanupComplete,true);assert.equal(JSON.parse(await command(realDocker,['image','inspect',fixtureId]))[0].Id,fixtureId);for(const row of restored)console.log(JSON.stringify(row));assert.deepEqual(await primary(),before);console.log(JSON.stringify({exactMissingScannerImageRecovered:true,primaryIncludingScannerIdsAndImagesUnchanged:true}));

}finally{if(fixtureContainer)await command(realDocker,['rm','-f',fixtureContainer]).catch(()=>{});if(fixtureTag)await command(realDocker,['image','rm',fixtureTag]).catch(()=>{});if(fixtureId)await command(realDocker,['image','rm',fixtureId]).catch(()=>{});for(const target of negative)await rm(target,{force:true});await rm(directory,{recursive:true,force:true});}
