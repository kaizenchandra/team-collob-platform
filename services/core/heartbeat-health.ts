import {assertWorkerHeartbeat} from './worker-heartbeat.ts';
const roles:Record<string,{filename:string;maxAge:number}>={digest:{filename:'/tmp/concord-digest-heartbeat',maxAge:60000},reconciler:{filename:'/tmp/concord-file-reconciler-heartbeat',maxAge:120000},media:{filename:'/tmp/concord-media-heartbeat',maxAge:30000}};
try{
  const role=process.argv[2],config=Object.hasOwn(roles,role)?roles[role]:undefined;
  if(process.argv.length!==3||!config)throw new Error('Unknown heartbeat role');
  await assertWorkerHeartbeat(config.filename,config.maxAge);
}catch{console.error('Worker heartbeat is not ready');process.exitCode=1;}
