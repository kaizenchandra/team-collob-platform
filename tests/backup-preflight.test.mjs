import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,createCipheriv,hkdfSync} from 'node:crypto';
import {mkdtemp,writeFile,readFile,rm,readdir,symlink,chmod,truncate} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {CompactEncrypt} from 'jose';
import {sha,maxBytes} from '../scripts/backup-common.mjs';
import {verifyImageArchive} from '../scripts/image-archive.mjs';
import {preflightBackup} from '../scripts/backup-preflight.mjs';

const name='core-images-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.bin',image='sha256:'+'a'.repeat(64);
function archive(key,images){
  const nonce=randomBytes(12),roles=images.scanner?['api','postgres','objects','scanner']:['api','postgres','objects'];
  const derived=Buffer.from(hkdfSync('sha256',key,Buffer.from('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),Buffer.from('concord-runtime-images-v1'),32));
  const cipher=createCipheriv('aes-256-gcm',derived,nonce);cipher.setAAD(Buffer.from(JSON.stringify([images.scanner?2:1,name,...roles.map(role=>images[role])])));
  // Deliberately not a Docker tar: preflight authenticates bytes, never claims importability.
  return Buffer.concat([Buffer.from('CNCRIMG1'),nonce,cipher.update(Buffer.from('opaque image archive')),cipher.final(),cipher.getAuthTag()]);
}
const encrypt=(data,key)=>new CompactEncrypt(Buffer.from(JSON.stringify(data))).setProtectedHeader({alg:'dir',enc:'A256GCM',cty:'application/concord-backup+json'}).encrypt(key);
const original=()=>({version:1,snapshotAt:'2026-10-17T00:00:00.000Z',images:{api:image,postgres:image,objects:image},counts:{files:0},database:Buffer.from('private database bytes').toString('base64'),databaseSha:sha('private database bytes'),files:[]});

test('companion preflight authenticates three/four-image protocols and rejects changed bytes/binding/type/bounds without staging',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'concord-preflight-test-')),key=randomBytes(32),target=path.join(directory,name);
  try{
    for(const scanner of [false,true]){
      const images={api:image,postgres:image,objects:image,...(scanner?{scanner:'sha256:'+'b'.repeat(64)}:{})},bytes=archive(key,images);
      await writeFile(target,bytes,{mode:0o600});const descriptor={format:'aes-256-gcm-v1',name,bytes:bytes.length,sha256:sha(bytes)},input={directory,descriptor,images,key};
      assert.deepEqual(await verifyImageArchive(input),{imageArchiveVerified:true});
      await assert.rejects(verifyImageArchive({...input,key:randomBytes(32)}),/authentication failed/);
      await assert.rejects(verifyImageArchive({...input,images:{...images,api:'sha256:'+'c'.repeat(64)}}),/authentication failed/);
      await assert.rejects(verifyImageArchive({...input,descriptor:{...descriptor,bytes:descriptor.bytes+1}}),/size/);
      await assert.rejects(verifyImageArchive({...input,descriptor:{...descriptor,sha256:'0'.repeat(64)}}),/digest/);
      for(const offset of [0,25,bytes.length-1]){
        const altered=Buffer.from(bytes);altered[offset]^=1;await writeFile(target,altered);
        await assert.rejects(verifyImageArchive({...input,descriptor:{...descriptor,sha256:sha(altered)}}),/header|authentication failed/);
      }
      await writeFile(target,bytes.subarray(0,-1));await assert.rejects(verifyImageArchive({...input,descriptor:{...descriptor,bytes:bytes.length-1,sha256:sha(bytes.subarray(0,-1))}}),/authentication failed/);
      await assert.rejects(verifyImageArchive({...input,descriptor:{...descriptor,bytes:4294967297}}));
      await rm(target);await symlink('elsewhere',target);await assert.rejects(verifyImageArchive(input));await rm(target);
      await assert.rejects(verifyImageArchive({...input,descriptor:{...descriptor,name:'../outside'}}));
    }
    assert.deepEqual(await readdir(directory),[]);
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('private envelope preflight keeps legacy scope and rejects unsafe keys/files and oversized input',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'concord-preflight-test-')),key=randomBytes(32),keyFile=path.join(directory,'key'),artifact=path.join(directory,'backup.jwe');
  try{
    await writeFile(keyFile,key,{mode:0o600});await writeFile(artifact,await encrypt(original(),key),{mode:0o600});
    const before=await readdir(directory),report=await preflightBackup(artifact,keyFile);
    assert.equal(report.envelopeVerified,true);assert.equal(report.imageArchiveVerified,false);assert.equal(report.scannerRefreshVerified,false);assert.equal(report.restoreVerified,false);assert.equal(report.scannerRuntimeVerified,false);assert.equal(report.fileBytesVerified,0);assert.ok(!JSON.stringify(report).includes('private database bytes'));assert.ok(!('database' in report));assert.deepEqual(await readdir(directory),before);
    const link=path.join(directory,'link');await symlink(artifact,link);await assert.rejects(preflightBackup(link,keyFile));await rm(link);await symlink(keyFile,link);await assert.rejects(preflightBackup(artifact,link));
    await chmod(keyFile,0o644);await assert.rejects(preflightBackup(artifact,keyFile),/private regular file/);await chmod(keyFile,0o600);
    await chmod(artifact,0o644);await assert.rejects(preflightBackup(artifact,keyFile),/private regular file/);await chmod(artifact,0o600);
    for(const size of [31,33]){await writeFile(keyFile,randomBytes(size));await assert.rejects(preflightBackup(artifact,keyFile),/size bounds/);}
    await writeFile(keyFile,randomBytes(32));await assert.rejects(preflightBackup(artifact,keyFile),/decryption/);await writeFile(keyFile,key);
    await assert.rejects(preflightBackup(directory,keyFile),/private regular file/);
    await truncate(artifact,maxBytes*2+1);await assert.rejects(preflightBackup(artifact,keyFile),/size bounds/);
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('preflight CLI needs opt-in, uses no Docker, and reports success without any restore claim',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'concord-preflight-test-')),key=randomBytes(32),keyFile=path.join(directory,'key'),artifact=path.join(directory,'backup.jwe'),run=promisify(execFile);
  try{
    await writeFile(keyFile,key,{mode:0o600});await writeFile(artifact,await encrypt(original(),key),{mode:0o600});
    const cli=path.resolve('scripts/verify-backup.mjs'),env={...process.env,PATH:directory,ALLOW_LOCAL_BACKUP:'true'};
    const {stdout}=await run(process.execPath,[cli,artifact,keyFile],{env});assert.equal(JSON.parse(stdout).envelopeVerified,true);assert.equal(JSON.parse(stdout).restoreVerified,false);
    await assert.rejects(run(process.execPath,[cli,artifact,keyFile],{env:{...env,ALLOW_LOCAL_BACKUP:'false'}}),/opt-in required/);
    await assert.rejects(run(process.execPath,[cli,artifact,keyFile,'extra'],{env}),/Usage/);
    assert.deepEqual((await readdir(directory)).sort(),['backup.jwe','key']);assert.equal((await readFile(keyFile)).length,32);
  }finally{await rm(directory,{recursive:true,force:true});}
});
