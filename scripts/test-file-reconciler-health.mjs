import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {setTimeout} from 'node:timers/promises';
import pg from 'pg';
const compose=['compose','-f','compose.yaml','-f','compose.local.yaml','-f','compose.identity.yaml','-f','compose.scanning.yaml','-f','compose.storage.yaml','-f','compose.email.yaml'];
const docker=(...args)=>execFileSync('docker',args,{encoding:'utf8',timeout:45000,maxBuffer:1024*1024}).trim();
const config=JSON.parse(docker(...compose,'config','--format','json'));
const image=process.env.FILE_RECONCILER_HEALTH_IMAGE??`concord-api:${JSON.parse(await readFile('package.json','utf8')).version}-local`;
const suffix=randomUUID().replaceAll('-',''),database=`reconcile_health_${suffix}`,container=`concord-reconcile-health-${suffix}`,young=randomUUID(),old=randomUUID();
const admin=new pg.Pool({connectionString:process.env.TEST_ADMIN_DATABASE_URL??'postgres://concord:local-development-only@localhost:55432/postgres'});
let db,created=false,started=false;
const status=()=>JSON.parse(docker('inspect',container))[0].State;
const logs=()=>{const result=spawnSync('docker',['logs','--tail','20',container],{encoding:'utf8',timeout:15000});assert.equal(result.status,0,'Cannot read test container logs');return result.stdout+result.stderr;};
async function waitFor(label,predicate,timeout=15000){
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline){if(await predicate()){console.log(label);return;}assert.equal(status().Running,true,`Worker exited during ${label}`);await setTimeout(500);}
  throw new Error(`Timed out: ${label}`);
}
try{
  await admin.query(`CREATE DATABASE "${database}"`);created=true;
  const connection=new URL(process.env.TEST_ADMIN_DATABASE_URL??'postgres://concord:local-development-only@localhost:55432/postgres');connection.pathname='/'+database;db=new pg.Pool({connectionString:connection.href});
  const [postgres]=JSON.parse(docker('inspect','concord-collaboration-postgres-1'));
  const network=Object.keys(postgres.NetworkSettings.Networks).find(name=>name.endsWith('_default'));assert.ok(network,'Compose database network missing');
  const databaseEnv=`DATABASE_URL=postgres://concord:local-development-only@postgres:5432/${database}`;
  docker('run','--rm','--network',network,'-e',databaseEnv,image,'node','--input-type=module','-e',"const {migrate,pool}=await import('./services/core/db.ts');try{await migrate();}finally{await pool.end();}");
  await db.query('ALTER TABLE files RENAME TO files_reconciler_health_fault');
  const check=config.services['file-reconciler'].healthcheck.test;assert.equal(check[0],'CMD');
  const setup=`import fs from 'node:fs';const root='/tmp/concord-health-files';fs.mkdirSync(root,{recursive:true});fs.writeFileSync(root+'/${young}','young synthetic bytes');fs.writeFileSync(root+'/${old}','old synthetic orphan');const age=new Date(Date.now()-7200000);fs.utimesSync(root+'/${old}',age,age);fs.writeFileSync('/tmp/concord-file-reconciler-heartbeat',String(Date.now()));await import('./services/core/file-reconciler.ts');`;
  docker('run','-d','--name',container,'--network',network,'--memory','128m','--cpus','0.25','-e','NODE_ENV=development','-e',databaseEnv,'-e','FILE_ROOT=/tmp/concord-health-files',
    '--health-cmd',check.slice(1).map(value=>"'"+value.replaceAll("'","'\\''")+"'").join(' '),
    '--health-interval','1s','--health-timeout',config.services['file-reconciler'].healthcheck.timeout??'3s','--health-retries','1',image,'node','--input-type=module','-e',setup);started=true;
  await waitFor('Actual reconciliation SQL failure observed',()=>logs().includes('file_reconciliation_unavailable'));
  await waitFor('Failed reconciliation unhealthy despite seeded fresh heartbeat',()=>status().Health?.Status==='unhealthy');
  assert.equal(docker('exec',container,'node','-e',"console.log(require('node:fs').existsSync('/tmp/concord-file-reconciler-heartbeat'))"),'false');
  const files=()=>JSON.parse(docker('exec',container,'node','-e',"console.log(JSON.stringify(require('node:fs').readdirSync('/tmp/concord-health-files')))"));
  assert.deepEqual(files().sort(),[young,old].sort());
  await db.query('ALTER TABLE files_reconciler_health_fault RENAME TO files');
  const recovery=Date.now();await waitFor('Restored database recovers health at normal 60-second reconciliation cadence',()=>status().Health?.Status==='healthy',90000);
  assert.ok(logs().includes('"removed":1'),'Successful reconciliation did not remove its aged synthetic orphan');
  assert.deepEqual(files(),[young]);assert.equal(docker('exec',container,'node','-e',`console.log(require('node:fs').readFileSync('/tmp/concord-health-files/${young}','utf8'))`),'young synthetic bytes');
  assert.equal((await db.query('SELECT count(*)::int n FROM files')).rows[0].n,0);
  console.log(`PASS: recovery ${Date.now()-recovery}ms; young bytes preserved, aged synthetic orphan removed. Zero file rows/uploads; no source volumes or S3 touched. Probe interval/retries accelerated only; normal worker cadence retained.`);
}finally{
  if(started){docker('stop','--time','40',container);docker('rm',container);}
  await db?.end();if(created)await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);await admin.end();console.log('Temporary reconciler container, bytes and database cleaned up.');
}
