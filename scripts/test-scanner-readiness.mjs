import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {setTimeout} from 'node:timers/promises';
const scanner='concord-collaboration-clamav-1',worker='concord-collaboration-file-worker-1';
const docker=(...args)=>execFileSync('docker',args,{encoding:'utf8',timeout:30000});
const health=name=>JSON.parse(docker('inspect',name))[0].State.Health.Status;
async function waitFor(name,state,timeout){const start=Date.now();while(Date.now()-start<timeout){if(health(name)===state)return;await setTimeout(2000);}throw new Error(`${name} did not become ${state}`);}
if(process.env.ALLOW_LOCAL_SCANNER_TEST!=='true')throw new Error('Explicit local scanner fault-test opt-in required');
assert.equal(health(scanner),'healthy');assert.equal(health(worker),'healthy');
let stopped=false;
try{
  docker('stop',scanner);stopped=true;
  await waitFor(worker,'unhealthy',90000);
  const r=await fetch('http://localhost:4100/ready',{signal:AbortSignal.timeout(5000)});assert.equal(r.status,200);
  console.log(JSON.stringify({scannerStopped:true,workerUnhealthy:true,coreReady:true}));
}finally{
  if(stopped)docker('start',scanner);
}
await waitFor(scanner,'healthy',180000);await waitFor(worker,'healthy',90000);
console.log(JSON.stringify({scannerRecovered:true,workerHealthy:true}));
