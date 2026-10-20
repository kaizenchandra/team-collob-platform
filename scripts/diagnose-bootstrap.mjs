// Explicit diagnostic for the existing isolated core-test database; never the application database.
import {spawnSync} from 'node:child_process';
const rounds=Number(process.env.BOOTSTRAP_DIAGNOSTIC_ROUNDS??'5');
if(!Number.isInteger(rounds)||rounds<1||rounds>10)throw new Error('Use 1–10 diagnostic rounds');
if(!process.argv.includes('--child')){
  for(let round=1;round<=rounds;round++){
    const child=spawnSync(process.execPath,['--import','tsx',import.meta.filename,'--child'],{encoding:'utf8',timeout:45000,env:{...process.env,DATABASE_URL:process.env.TEST_DATABASE_URL??'postgres://concord:local-development-only@localhost:55432/concord_test'},maxBuffer:1024*1024});
    console.log(JSON.stringify({round,status:child.status,error:child.error?.message}));process.stdout.write(child.stdout??'');process.stderr.write(child.stderr??'');if(child.status!==0){process.exitCode=1;break;}
  }
}else{
  if(new URL(process.env.DATABASE_URL??'').pathname!=='/concord_test')throw new Error('Diagnostic requires the isolated concord_test database');
  process.env.DEV_AUTH='true';process.env.LOG_LEVEL='silent';process.env.FILE_ROOT='.data/test-files';
  const {pool,migrate}=await import('../services/core/db.ts'),{seed,ids}=await import('../services/core/seed.ts'),{createApp}=await import('../services/core/server.ts');
  await migrate();await seed();let phase='setup';const diagnostics=[];
  pool.on('connect',()=>diagnostics.push({event:'connect',phase,total:pool.totalCount,idle:pool.idleCount,waiting:pool.waitingCount}));
  const query=pool.query.bind(pool);pool.query=(...args)=>{const begin=Date.now();return query(...args).catch(error=>{diagnostics.push({event:'query-error',phase,ms:Date.now()-begin,name:error.name,code:error.code,message:error.message,total:pool.totalCount,idle:pool.idleCount,waiting:pool.waitingCount});throw error;});};
  const app=await createApp(),cookies={};const origin='http://localhost:3100';
  try{
    for(const [name,email]of [['alice','alice@acme.test'],['bob','bob@acme.test'],['eve','eve@northstar.test'],['guest','guest@partner.test']]){const response=await app.inject({method:'POST',url:'/v1/session',headers:{origin},payload:{email,password:'Development123!'}});if(response.statusCode!==200)throw new Error('Diagnostic login failed: '+response.statusCode);cookies[name]=String(response.headers['set-cookie']).split(';')[0];}
    phase='tenant-denials';
    for(const route of [`/organizations/${ids.org}/bootstrap`,`/channels/${ids.channel}/messages`,`/organizations/${ids.org}/search?q=welcome`,`/channels/${ids.private}/tasks`,`/channels/${ids.private}/forms`,`/organizations/${ids.org}/activity`,`/organizations/${ids.org}/audit`,`/channels/${ids.channel}/files`]){const response=await app.inject({url:'/v1'+route,headers:{origin,cookie:cookies.eve}});if(response.statusCode!==404)throw new Error('Unexpected tenant response: '+response.statusCode);}
    await app.inject({url:`/v1/organizations/${ids.org}/audit`,headers:{origin,cookie:cookies.bob}});
    phase='guest-bootstrap';const begin=Date.now(),response=await app.inject({url:`/v1/organizations/${ids.org}/bootstrap`,headers:{origin,cookie:cookies.guest}});console.log(JSON.stringify({status:response.statusCode,ms:Date.now()-begin,diagnostics}));if(response.statusCode!==200)process.exitCode=1;
  }finally{await app.close();await pool.end();}
}
