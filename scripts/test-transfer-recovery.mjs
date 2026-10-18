import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {command} from './backup-common.mjs';
if(process.env.ALLOW_LOCAL_BACKUP!=='true')throw new Error('Explicit local restore opt-in required');
const [kitArg,artifactArg,keyArg='.data/backup-keys/local-core.key']=process.argv.slice(2);
if(!kitArg||!artifactArg)throw new Error('Usage: test-transfer-recovery.mjs KIT BACKUP [KEY]');
const kit=path.resolve(kitArg),artifact=path.resolve(artifactArg),key=path.resolve(keyArg),directory=await mkdtemp(path.join(tmpdir(),'concord-transfer-drill-'));
const realDocker=(await command('which',['docker'])).toString().trim();
const primary=()=>command(realDocker,['inspect','concord-collaboration-api-1','concord-collaboration-postgres-1','concord-collaboration-object-store-1']).then(b=>JSON.parse(b).map(c=>[c.Id,c.Image]));
const inventory=async()=>({containers:(await command(realDocker,['ps','-a','--filter','name=concord-restore-','--format','{{.Names}}'])).toString().trim(),volumes:(await command(realDocker,['volume','ls','--filter','name=concord-restore-','--format','{{.Name}}'])).toString().trim(),networks:(await command(realDocker,['network','ls','--filter','name=concord-restore-','--format','{{.Name}}'])).toString().trim(),temporary:(await readdir(tmpdir())).filter(n=>n.startsWith('concord-recovery-kit-')||n.startsWith('concord-images-')).sort()});
try{
  const before=await primary(),baseline=await inventory();
  // Refuse daemon-host bind paths while forwarding ordinary Docker calls to the real engine.
  await writeFile(path.join(directory,'docker'),`#!/usr/bin/env node
const {spawn}=require('node:child_process'),{appendFileSync}=require('node:fs');
const args=process.argv.slice(2);
if(args.some(a=>a.includes('type=bind'))||(['create','run'].includes(args[0])&&args.some(a=>a==='-v'||a==='--volume'||a.startsWith('--volume=')))){console.error('Host bind mount forbidden by drill');process.exit(91);}
if(args[0]==='cp'){
  const target=args.at(-1);appendFileSync(process.env.TRANSFER_LOG,JSON.stringify({target})+'\\n');
  if(process.env.TRANSFER_FAIL&&target.includes('-'+process.env.TRANSFER_FAIL+':')){console.error('Injected restore transfer failure');process.exit(92);}
}
const child=spawn(process.env.TRANSFER_DOCKER,args,{stdio:'inherit'});child.on('error',e=>{console.error(e.message);process.exitCode=1;});child.on('close',code=>{process.exitCode=code??1;});
`,{flag:'wx',mode:0o700});
  const log=path.join(directory,'transfers.jsonl');
  for(const failure of ['objects','verify','']){
    await writeFile(log,'');
    const previous=process.cwd();process.chdir(directory);let result,error;
    const saved={PATH:process.env.PATH,TRANSFER_LOG:process.env.TRANSFER_LOG,TRANSFER_FAIL:process.env.TRANSFER_FAIL,TRANSFER_DOCKER:process.env.TRANSFER_DOCKER};
    try{
      Object.assign(process.env,{PATH:directory+path.delimiter+saved.PATH,TRANSFER_LOG:log,TRANSFER_FAIL:failure,TRANSFER_DOCKER:realDocker});
      try{result=await command(process.execPath,[path.join(kit,'run-recovery-kit.mjs'),artifact,key]);}catch(e){error=e;}
    }finally{process.chdir(previous);for(const [name,value] of Object.entries(saved)){if(value===undefined)delete process.env[name];else process.env[name]=value;}}
    const transfers=(await readFile(log,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
    assert.equal(transfers.length,failure==='objects'?1:2);
    if(failure){assert.ok(error,'Injected failure must fail the drill');assert.match(error.message,/Injected restore transfer failure/);assert.ok(error.stdout.includes('"cleanupComplete":true'));console.log(JSON.stringify({injectedTransferFailure:failure,rejected:true,cleanupComplete:true}));}
    else{assert.ifError(error);const rows=result.toString().trim().split('\n').map(JSON.parse);assert.equal(rows[0].countsMatch,true);assert.equal(rows[0].imageArchiveVerified,true);assert.equal(rows[1].cleanupComplete,true);for(const row of rows)console.log(JSON.stringify(row));console.log(JSON.stringify({hostBindMountsForbidden:true,transfers:transfers.length,kitExecutedOutsideCheckout:true}));}
    assert.deepEqual(await primary(),before);assert.deepEqual(await inventory(),baseline);
  }
  console.log(JSON.stringify({primaryContainerIdsAndImagesUnchanged:true,restoreResourcesAndTemporaryDirectoriesUnchanged:true}));
}finally{await rm(directory,{recursive:true,force:true});}
