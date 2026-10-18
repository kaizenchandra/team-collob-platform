import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {stageKit,authenticate,digest} from '../scripts/run-recovery-kit.mjs';

test('kit authenticates and stages exact bytes; rejects modified code/config, key, backup, manifest and links',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'concord-kit-test-')),key=randomBytes(32),artifact=path.join(root,'backup.jwe');
  try{
    await writeFile(artifact,'encrypted fixture');
    const entries=[];
    for(const name of ['scripts/restore-coordinated-backup.mjs','infra/seaweedfs/local-s3.json','package.json']){const bytes=Buffer.from(name);await mkdir(path.dirname(path.join(root,name)),{recursive:true});await writeFile(path.join(root,name),bytes);entries.push({path:name,bytes:bytes.length,sha256:digest(bytes)});}
    const manifest={version:1,artifactSha256:digest(await readFile(artifact)),files:entries};
    const sign=async()=>{const raw=Buffer.from(JSON.stringify(manifest));await writeFile(path.join(root,'manifest.json'),raw);await writeFile(path.join(root,'manifest.hmac'),authenticate(raw,key));};await sign();
    const staged=await stageKit(root,artifact,key);assert.equal((await readFile(path.join(staged,'package.json'))).toString(),'package.json');await rm(staged,{recursive:true,force:true});
    for(const name of [entries[0].path,entries[1].path]){await writeFile(path.join(root,name),'tampered');await assert.rejects(stageKit(root,artifact,key),/integrity|Invalid recovery/);await writeFile(path.join(root,name),name);}
    await assert.rejects(stageKit(root,artifact,randomBytes(32)),/authentication/);
    await writeFile(artifact,'wrong backup');await assert.rejects(stageKit(root,artifact,key),/backup mismatch/);await writeFile(artifact,'encrypted fixture');
    await writeFile(path.join(root,'manifest.json'),'{}');await assert.rejects(stageKit(root,artifact,key),/authentication/);await sign();
    const source=path.join(root,entries[0].path);await rm(source);await symlink(path.join(root,'package.json'),source);await assert.rejects(stageKit(root,artifact,key));await rm(source);await writeFile(source,entries[0].path);
    await rm(path.join(root,'infra'),{recursive:true});await symlink(path.join(root,'scripts'),path.join(root,'infra'));await assert.rejects(stageKit(root,artifact,key));
    manifest.files[0].path='../escape';await sign();await assert.rejects(stageKit(root,artifact,key),/Invalid kit file/);
  }finally{await rm(root,{recursive:true,force:true});}
});
