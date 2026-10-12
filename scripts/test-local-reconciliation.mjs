import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {setTimeout} from 'node:timers/promises';
if(process.env.TEST_RECONCILIATION!=='true')throw new Error('Explicit local reconciliation test opt-in required');
const old=randomUUID(),young=randomUUID();
function inside(code){return execFileSync('docker',['exec','concord-collaboration-api-1','node','--input-type=module','-e',`if(process.env.NODE_ENV!=='development')throw new Error('Local development only');${code}`],{encoding:'utf8'}).trim();}
const imports=`import {writeFile,utimes,access,unlink} from 'node:fs/promises';import path from 'node:path';import {fileRoot} from './services/core/file-content.ts';const old=path.join(fileRoot(),${JSON.stringify(old)}),young=path.join(fileRoot(),${JSON.stringify(young)});`;
const started=Date.now();
try{
  inside(`${imports}await writeFile(old,'task-owned orphan test',{flag:'wx'});await writeFile(young,'task-owned young test',{flag:'wx'});const age=new Date(Date.now()-7200000);await utimes(old,age,age);`);
  let removed=false;
  while(Date.now()-started<90000){
    const state=JSON.parse(inside(`${imports}console.log(JSON.stringify({old:await access(old).then(()=>true,()=>false),young:await access(young).then(()=>true,()=>false)}));`));
    if(!state.young)throw new Error('Reconciler removed a young fixture');
    if(!state.old){removed=true;break;}
    await setTimeout(1000);
  }
  if(!removed)throw new Error('Background reconciler did not remove old orphan within90seconds');
  console.log(JSON.stringify({test:'real local background orphan reconciliation',oldOrphanRemoved:true,youngFilePreserved:true,durationMs:Date.now()-started}));
}finally{inside(`${imports}await unlink(old).catch(e=>{if(e.code!=='ENOENT')throw e;});await unlink(young).catch(e=>{if(e.code!=='ENOENT')throw e;});`);}
