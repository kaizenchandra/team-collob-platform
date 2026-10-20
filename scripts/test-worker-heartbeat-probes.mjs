import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
const docker=(...args)=>execFileSync('docker',args,{encoding:'utf8',timeout:60000,maxBuffer:1024*1024}).trim();
const compose=['compose','-f','compose.yaml','-f','compose.local.yaml','-f','compose.identity.yaml','-f','compose.scanning.yaml','-f','compose.storage.yaml','-f','compose.email.yaml'];
const config=JSON.parse(docker(...compose,'config','--format','json'));
const image=process.env.HEARTBEAT_HEALTH_IMAGE??`concord-api:${JSON.parse(await readFile('package.json','utf8')).version}-local`;
const [postgres]=JSON.parse(docker('inspect','concord-collaboration-postgres-1'));
const network=Object.keys(postgres.NetworkSettings.Networks).find(name=>name.endsWith('_default'));assert.ok(network);
for(const [service,filename,ttl] of [['digest-worker','/tmp/concord-digest-heartbeat',60000],['file-reconciler','/tmp/concord-file-reconciler-heartbeat',120000],['file-worker','/tmp/concord-file-worker-heartbeat',120000]]){
  const check=process.env.HEARTBEAT_USE_RUNNING_PROBES==='true'?JSON.parse(docker('inspect',`concord-collaboration-${service}-1`))[0].Config.Healthcheck.Test:config.services[service].healthcheck.test;
  assert.equal(check[0],'CMD');
  const fixtures={service,filename,ttl,command:check.slice(1)};
  const program=`import fs from 'node:fs';import {spawnSync} from 'node:child_process';import assert from 'node:assert/strict';const fixture=${JSON.stringify(fixtures)};
    const run=(name,value,expected)=>{if(value===null)fs.rmSync(fixture.filename,{force:true});else fs.writeFileSync(fixture.filename,value);const result=spawnSync(fixture.command[0],fixture.command.slice(1),{encoding:'utf8',timeout:10000});assert.equal(result.status,expected,fixture.service+' '+name+' unexpected health');console.log(fixture.service+': '+name+' -> '+expected);};
    run('nonfinite','Infinity',1);run('excessive future',String(Date.now()+86400000),1);run('stale',String(Date.now()-fixture.ttl-1000),1);run('malformed','invalid',1);run('missing',null,1);run('fresh',String(Date.now()),0);
    if(fixture.command.includes('services/core/heartbeat-health.ts')){for(const args of [[...fixture.command.slice(1,-1),'unknown'],[...fixture.command.slice(1),'extra']])assert.equal(spawnSync(fixture.command[0],args,{encoding:'utf8',timeout:10000}).status,1);console.log(fixture.service+': invalid role/extra argument -> 1');}
    console.log('PASS: disposable heartbeat files only; fresh scan probe uses actual ClamAV.');`;
  console.log(docker('run','--rm','--network',network,'--memory','256m','--cpus','0.5','-e','CLAMAV_HOST=clamav','-e','CLAMAV_PORT=3310',image,'node','--input-type=module','-e',program));
}
console.log('All disposable probe containers removed; no running heartbeat/source volumes/database/S3 changed.');
