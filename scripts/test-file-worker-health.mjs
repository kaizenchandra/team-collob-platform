import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {setTimeout} from 'node:timers/promises';
import pg from 'pg';
const compose=['compose','-f','compose.yaml','-f','compose.local.yaml','-f','compose.identity.yaml','-f','compose.scanning.yaml','-f','compose.storage.yaml','-f','compose.email.yaml'];
const docker=(...args)=>execFileSync('docker',args,{encoding:'utf8',timeout:45000,maxBuffer:1024*1024}).trim();
const config=JSON.parse(docker(...compose,'config','--format','json'));
const image=process.env.FILE_WORKER_HEALTH_IMAGE??`concord-api:${JSON.parse(await readFile('package.json','utf8')).version}-local`;
const suffix=randomUUID().replaceAll('-',''),database=`scan_health_${suffix}`,container=`concord-scan-health-${suffix}`;
const admin=new pg.Pool({connectionString:process.env.TEST_ADMIN_DATABASE_URL??'postgres://concord:local-development-only@localhost:55432/postgres'});
let db,created=false,started=false;
const status=()=>JSON.parse(docker('inspect',container))[0].State;
async function waitFor(label,predicate){
  const deadline=Date.now()+45000;
  while(Date.now()<deadline){if(await predicate()){console.log(label);return;}const state=status();assert.equal(state.Running,true,`Worker exited during ${label}`);await setTimeout(500);}
  throw new Error(`Timed out: ${label}`);
}
try{
  await admin.query(`CREATE DATABASE "${database}"`);created=true;
  const connection=new URL(process.env.TEST_ADMIN_DATABASE_URL??'postgres://concord:local-development-only@localhost:55432/postgres');connection.pathname='/'+database;
  db=new pg.Pool({connectionString:connection.href});
  const [postgres]=JSON.parse(docker('inspect','concord-collaboration-postgres-1'));
  const networks=Object.keys(postgres.NetworkSettings.Networks);
  const network=networks.find(name=>name.endsWith('_default'));assert.ok(network,'Compose database network missing');
  const check=config.services['file-worker'].healthcheck.test;assert.equal(check[0],'CMD');
  docker('run','-d','--name',container,'--network',network,'--memory','256m','--cpus','0.5',
    '-e','NODE_ENV=development','-e',`DATABASE_URL=postgres://concord:local-development-only@postgres:5432/${database}`,
    '-e','CLAMAV_HOST=clamav','-e','CLAMAV_PORT=3310','-e','FILE_ROOT=/tmp/concord-health-files',
    '--health-cmd',check.slice(1).map(value=>"'"+value.replaceAll("'","'\\''")+"'").join(' '),
    '--health-interval','1s','--health-timeout',config.services['file-worker'].healthcheck.timeout??'5s','--health-retries','1',image,'node','services/core/file-worker.ts');started=true;
  await waitFor('Idle file worker and actual ClamAV probe healthy',()=>status().Health?.Status==='healthy');
  await db.query('ALTER TABLE file_scan_jobs RENAME TO file_scan_jobs_health_fault');
  await waitFor('Database failure makes worker unhealthy',()=>status().Health?.Status==='unhealthy');
  assert.equal(docker('exec',container,'node','-e',"console.log(require('node:fs').existsSync('/tmp/concord-file-worker-heartbeat'))"),'false');
  await db.query('ALTER TABLE file_scan_jobs_health_fault RENAME TO file_scan_jobs');
  await waitFor('Database recovery restores healthy worker',()=>status().Health?.Status==='healthy');
  assert.equal((await db.query('SELECT count(*)::int n FROM file_scan_jobs')).rows[0].n,0);
  assert.equal((await db.query('SELECT count(*)::int n FROM files')).rows[0].n,0);
  console.log('PASS: no file rows/jobs/uploads created; no source volumes mounted. Only the temporary database was faulted; actual ClamAV readiness was checked. Probe command matches Compose; interval/retries accelerated for this test.');
}finally{
  if(started){docker('stop','--time','40',container);docker('rm',container);}
  await db?.end();
  if(created)await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
  await admin.end();
  console.log('Temporary worker container and database cleaned up.');
}
