import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile,readdir,stat,writeFile,mkdir} from 'node:fs/promises';
const paths=['app','services','lib','migrations','package.json','package-lock.json','next.config.ts','Dockerfile','compose.yaml','compose.local.yaml','compose.identity.yaml','compose.scanning.yaml','infra','scripts','tests','playwright.config.ts','tsconfig.json','eslint.config.mjs','.github'];
const files=[];
async function collect(path){if((await stat(path)).isDirectory()){for(const child of (await readdir(path)).sort())await collect(`${path}/${child}`);}else files.push(path);}
for(const path of paths)await collect(path);
const hash=createHash('sha256');for(const path of files.sort()){hash.update(path+'\0');hash.update(await readFile(path));}
const images={};for(const name of ['concord-web:0.1.12-local','concord-api:0.1.12-local','concord-scanner:0.1.10-local']){const [i]=JSON.parse(execFileSync('docker',['image','inspect',name],{encoding:'utf8'}));images[name]={imageId:i.Id,created:i.Created,platform:`${i.Os}/${i.Architecture}`};}
const containers={};for(const service of ['web','api','postgres','keycloak','clamav','file-worker','file-reconciler']){const [c]=JSON.parse(execFileSync('docker',['inspect',`concord-collaboration-${service}-1`],{encoding:'utf8'}));containers[service]={imageId:c.Image,status:c.State.Status,health:c.State.Health?.Status??'none'};}
const record={version:'0.1.12-local',environment:'Loopback Docker development deployment, not full-scope staging or production',recordedAt:new Date().toISOString(),url:'http://localhost:3101',api:'http://localhost:4100',sourceSha256:hash.digest('hex'),sourceFiles:files,baseCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),uncommittedSource:true,images,containers,requiredProductionGate:'Not passed; see requirements.json and VERIFICATION.md'};
await mkdir('docs/evidence',{recursive:true});await writeFile('docs/evidence/release.json',JSON.stringify(record,null,2)+'\n');console.log(JSON.stringify({version:record.version,sourceSha256:record.sourceSha256,containers},null,2));
