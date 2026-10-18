import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {transferFiles} from '../scripts/restore-transfer.mjs';

test('restore transfer creates bounded read-only flat tar entries and rejects unsafe input before Docker',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'concord-transfer-test-')),source=path.join(root,'helper'),container='concord-restore-1234abcd-verify';
  try{
    const content=Buffer.alloc(513,65);await writeFile(source,content);let calls=0;
    const docker=async(args,tar)=>{calls++;assert.deepEqual(args,['cp','-',container+':/app/']);const header=tar.subarray(0,512);assert.equal(header.subarray(0,100).toString().replace(/\0.*$/s,''),'helper.mjs');assert.equal(parseInt(header.subarray(100,108).toString(),8),0o444);assert.equal(parseInt(header.subarray(124,136).toString(),8),513);const checksum=parseInt(header.subarray(148,156).toString(),8),copy=Buffer.from(header);copy.fill(32,148,156);assert.equal(copy.reduce((sum,b)=>sum+b,0),checksum);assert.ok(tar.subarray(512,1025).equals(content));assert.equal(tar.length,2560);assert.ok(tar.subarray(-1024).equals(Buffer.alloc(1024)));};
    await transferFiles(docker,container,'/app',[{source,name:'helper.mjs'}]);assert.equal(calls,1);
    for(const [target,destination,files] of [[container,'/etc',[{source,name:'helper.mjs'}]],['primary-api','/app',[{source,name:'helper.mjs'}]],[container,'/app',[{source,name:'../helper.mjs'}]],[container,'/app',[{source,name:'helper.mjs'},{source,name:'helper.mjs'}]]])await assert.rejects(transferFiles(docker,target,destination,files));
    const link=path.join(root,'link');await symlink(source,link);await assert.rejects(transferFiles(docker,container,'/app',[{source:link,name:'helper.mjs'}]));
    await writeFile(source,Buffer.alloc(1024*1024+1));await assert.rejects(transferFiles(docker,container,'/app',[{source,name:'helper.mjs'}]));assert.equal(calls,1);
  }finally{await rm(root,{recursive:true,force:true});}
});
