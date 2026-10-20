import {execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {assertReleaseHealth,releaseServices,assertMediaReleaseHealth,mediaReleaseServices} from './release-health.mjs';
import {readFile,readdir,stat,writeFile,mkdir,rename,rm} from 'node:fs/promises';
const {version}=JSON.parse(await readFile('package.json','utf8'));
if(!/^\d+\.\d+\.\d+$/.test(version))throw new Error('Invalid release version');
const inspect=(args)=>JSON.parse(execFileSync('docker',args,{encoding:'utf8',timeout:15000,maxBuffer:4*1024*1024}));
const paths=['app','services','lib','migrations','package.json','package-lock.json','next.config.ts','Dockerfile','compose.yaml','compose.local.yaml','compose.identity.yaml','compose.scanning.yaml','compose.storage.yaml','compose.email.yaml','compose.media.yaml','public/media','infra','scripts','tests','playwright.config.ts','tsconfig.json','eslint.config.mjs','.github'];
const files=[];
async function collect(path){if((await stat(path)).isDirectory()){for(const child of (await readdir(path)).sort())await collect(`${path}/${child}`);}else files.push(path);}
for(const path of paths)await collect(path);
const hash=createHash('sha256');for(const path of files.sort()){hash.update(path+'\0');hash.update(await readFile(path));}
const images={};for(const name of [`concord-web:${version}-local`,`concord-api:${version}-local`,'concord-scanner:0.1.10-local','chrislusf/seaweedfs:4.48','axllent/mailpit:v1.31.5']){const [i]=inspect(['image','inspect',name]);images[name]={imageId:i.Id,created:i.Created,platform:`${i.Os}/${i.Architecture}`};}
const containers={};for(const service of [...releaseServices,...mediaReleaseServices]){const [c]=inspect(['inspect',`concord-collaboration-${service}-1`]);containers[service]={imageId:c.Image,status:c.State.Status,health:c.State.Health?.Status??'none'};}
assertReleaseHealth(containers,images,version);assertMediaReleaseHealth(containers,images,version);
const checks=await Promise.all(['http://localhost:4100/health','http://localhost:4100/ready','http://localhost:3101'].map(async url=>{const r=await fetch(url,{signal:AbortSignal.timeout(10000),redirect:'error'});if(!r.ok)throw new Error(`Release blocked: ${url} returned ${r.status}`);if(url.endsWith('/health')){if((await r.json()).release!==version)throw new Error('Release blocked: API reports a different version');}else await r.body?.cancel();return {url,status:r.status};}));
const mediaAcceptance={independentPhysicalDevicesVerified:false,scope:'Local browser simulation against real LiveKit SFU and Egress; see docs/MEDIA.md'};
const record={mediaAcceptance,version:`${version}-local`,checks,environment:'Loopback Docker development deployment, not full-scope staging or production',recordedAt:new Date().toISOString(),url:'http://localhost:3101',api:'http://localhost:4100',sourceSha256:hash.digest('hex'),sourceFiles:files,baseCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),uncommittedSource:true,images,containers,requiredProductionGate:'Not passed; see requirements.json and VERIFICATION.md'};
await mkdir('docs/evidence',{recursive:true});const temporary=`docs/evidence/.release-${randomUUID()}.tmp`;
try{await writeFile(temporary,JSON.stringify(record,null,2)+'\n',{flag:'wx'});await rename(temporary,'docs/evidence/release.json');}finally{await rm(temporary,{force:true});}console.log(JSON.stringify({version:record.version,sourceSha256:record.sourceSha256,containers},null,2));
