import {spawn} from 'node:child_process';
import {createHash,createCipheriv,createDecipheriv,hkdfSync,randomBytes} from 'node:crypto';
import {createWriteStream,constants} from 'node:fs';
import {open,mkdtemp,rm,lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Transform,Writable} from 'node:stream';
import {pipeline,finished} from 'node:stream/promises';
import {imageArchiveSchema,maxImageArchiveBytes} from './image-archive-contract.mjs';
const magic=Buffer.from('CNCRIMG1'),headerBytes=20,tagBytes=16;
const imageRoles=images=>images.scanner?['api','postgres','objects','scanner']:['api','postgres','objects'];
function context(key,name,images){
  const roles=imageRoles(images);
  if(key.length!==32)throw new Error('Image archive key must be32bytes');
  if(!roles.every(role=>/^sha256:[a-f0-9]{64}$/.test(images[role])))throw new Error('Invalid image IDs');
  const uuid=name.slice('core-images-'.length,-4),derived=Buffer.from(hkdfSync('sha256',key,Buffer.from(uuid),Buffer.from('concord-runtime-images-v1'),32));
  return {key:derived,aad:Buffer.from(JSON.stringify([images.scanner?2:1,name,...roles.map(role=>images[role])]))};
}
function processCommand(args){
  const child=spawn('docker',args,{stdio:['ignore','pipe','pipe']});let stderr='',stdout='',settled=false;
  const done=new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('Image archive command deadline exceeded'));},600000);
    child.stderr.on('data',b=>{if(stderr.length<8192)stderr+=b.toString();});
    child.on('error',e=>{clearTimeout(timer);settled=true;reject(e);});
    child.on('close',code=>{clearTimeout(timer);settled=true;if(code!==0)reject(new Error(`Image archive docker command failed (${code}): ${stderr.slice(0,1000)}`));else resolve(stdout);});
  });
  return {child,done,collect(){child.stdout.on('data',b=>{if(stdout.length<65536)stdout+=b.toString();});},kill(){if(!settled)child.kill('SIGKILL');}};
}
function limiter(max){let bytes=0;return new Transform({transform(chunk,encoding,cb){bytes+=chunk.length;if(bytes>max)cb(new Error('Image archive byte limit exceeded'));else cb(null,chunk);}});}
export async function imageFileDigest(file){
  const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const info=await handle.stat();if(!info.isFile()||info.size>maxImageArchiveBytes)throw new Error('Invalid image archive size');const hash=createHash('sha256');for await(const chunk of handle.createReadStream({autoClose:false}))hash.update(chunk);return {bytes:info.size,sha256:hash.digest('hex')};}finally{await handle.close();}
}
export async function exportImageArchive({directory,name,images,key}){
  imageArchiveSchema.parse({format:'aes-256-gcm-v1',name,bytes:36,sha256:'0'.repeat(64)});
  const target=path.join(directory,name),nonce=randomBytes(12),c=context(key,name,images),cipher=createCipheriv('aes-256-gcm',c.key,nonce);cipher.setAAD(c.aad);
  const output=createWriteStream(target,{flags:'wx',mode:0o600});let created=false;
  output.once('open',()=>{created=true;});
  const proc=processCommand(['image','save',...new Set(imageRoles(images).map(role=>images[role]))]);
  try{
    output.write(Buffer.concat([magic,nonce]));
    await Promise.all([pipeline(proc.child.stdout,limiter(maxImageArchiveBytes-headerBytes-tagBytes),cipher,output,{end:false}),proc.done]);
    output.end(cipher.getAuthTag());await finished(output);
    const h=await open(target,'r');try{await h.sync();}finally{await h.close();}
    return imageArchiveSchema.parse({format:'aes-256-gcm-v1',name,...await imageFileDigest(target)});
  }catch(error){proc.kill();output.destroy();await finished(output).catch(()=>{});if(created)await rm(target,{force:true});throw error;}
}
export async function inspectImages(images){
  const missing=[];
  for(const role of imageRoles(images)){const p=processCommand(['image','inspect',images[role]]);p.collect();try{const result=JSON.parse(await p.done);if(result[0]?.Id!==images[role])throw new Error('Image identity mismatch');}catch{missing.push(role);}}
  return missing;
}
async function authenticateImageArchive({directory,descriptor,images,key},output){
  const d=imageArchiveSchema.parse(descriptor),source=path.join(directory,d.name),info=await lstat(source);if(!info.isFile()||info.isSymbolicLink()||info.size!==d.bytes)throw new Error('Image archive size or file type mismatch');
  const handle=await open(source,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
    const meta=await handle.stat();if(!meta.isFile()||meta.size!==d.bytes)throw new Error('Image archive size mismatch');
    const digest=createHash('sha256');for await(const chunk of handle.createReadStream({start:0,autoClose:false}))digest.update(chunk);if(digest.digest('hex')!==d.sha256)throw new Error('Image archive digest mismatch');
    const header=Buffer.alloc(headerBytes),tag=Buffer.alloc(tagBytes);if((await handle.read(header,0,headerBytes,0)).bytesRead!==headerBytes||!header.subarray(0,8).equals(magic))throw new Error('Invalid image archive header');if((await handle.read(tag,0,tagBytes,meta.size-tagBytes)).bytesRead!==tagBytes)throw new Error('Invalid image archive tag');
    const c=context(key,d.name,images),decipher=createDecipheriv('aes-256-gcm',c.key,header.subarray(8));decipher.setAAD(c.aad);decipher.setAuthTag(tag);
    try{await pipeline(handle.createReadStream({start:headerBytes,end:meta.size-tagBytes-1,autoClose:false}),decipher,output());}catch{throw new Error('Image archive authentication failed');}
    return {imageArchiveVerified:true};
  }finally{await handle.close();}
}
export function verifyImageArchive(input){return authenticateImageArchive(input,()=>new Writable({write(chunk,encoding,callback){callback();}}));}
export async function prepareImages(input){
  const {descriptor,images}=input,missing=await inspectImages(images);
  if(!descriptor){if(missing.length)throw new Error(`Recorded image unavailable: ${missing.join(', ')}; no portable image archive in this backup`);return {imageArchiveVerified:false,imagesImported:false};}
  let temporary;
  try{
    if(missing.length){
      temporary=await mkdtemp(path.join(tmpdir(),'concord-images-'));const tar=path.join(temporary,'images.tar');
      await authenticateImageArchive(input,()=>createWriteStream(tar,{flags:'wx',mode:0o600}));
      const p=processCommand(['image','load','--input',tar]);p.collect();await p.done;
    }else await verifyImageArchive(input);
    if((await inspectImages(images)).length)throw new Error('Imported image identity mismatch');
    return {imageArchiveVerified:true,imagesImported:missing.length>0};
  }finally{if(temporary)await rm(temporary,{recursive:true,force:true});}
}
