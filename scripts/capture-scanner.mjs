import {mkdtemp,mkdir,rm,lstat,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {command} from './backup-common.mjs';
import {imageFileDigest} from './image-archive.mjs';
import {scannerFileName,scannerManifestSchema} from './scanner-contract.mjs';
export async function captureScanner(id){
  if(!/^[a-f0-9-]{36}$/.test(id))throw new Error('Invalid scanner capture ID');
  const source='concord-collaboration-clamav-1',container='concord-scanner-capture-'+id,tag='concord-scanner-snapshot:'+id;
  const docker=(args)=>command('docker',args),temporary=await mkdtemp(path.join(tmpdir(),'concord-scanner-capture-'));let committed=false;
  try{
    const [running]=JSON.parse(await docker(['inspect',source]));if(!running.State.Running)throw new Error('Source scanner unavailable');
    const [image]=JSON.parse(await docker(['image','inspect',running.Image]));if(Object.keys(image.Config.Volumes??{}).some(v=>v==='/var/lib/clamav'||'/var/lib/clamav'.startsWith(v+'/')))throw new Error('Scanner image masks captured definitions with a volume');
    const names=(await docker(['exec',source,'find','/var/lib/clamav','-maxdepth','1','-type','f'])).toString().trim().split('\n').map(n=>path.posix.basename(n)).filter(n=>scannerFileName.safeParse(n).success).sort();
    if(names.length<3||names.length>16)throw new Error('Invalid scanner file count');
    const directory=path.join(temporary,'definitions');await mkdir(directory,{mode:0o700});const files=[];let total=0;
    for(const name of names){
      const bytes=Number((await docker(['exec',source,'stat','-c','%s','/var/lib/clamav/'+name])).toString().trim());
      if(!Number.isSafeInteger(bytes)||bytes<1||bytes>128*1024*1024||(total+=bytes)>256*1024*1024)throw new Error('Scanner definition size limit exceeded');
      const file=path.join(directory,name);await docker(['cp',source+':/var/lib/clamav/'+name,file]);const stat=await lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==bytes)throw new Error('Scanner definition changed during capture');
      await chmod(file,0o644);files.push({name,...await imageFileDigest(file)});
    }
    const manifest=scannerManifestSchema.parse({sourceImage:running.Image,capturedAt:new Date().toISOString(),files});
    // This container has no source volume and never joins a network. Remove only its baked-in databases.
    await docker(['run','--name',container,'--network','none','--user','0:0','--memory','128m','--entrypoint','/bin/sh',running.Image,'-c','rm -rf /var/lib/clamav/* && mkdir -p /var/log/clamav && chown -R clamav:clamav /var/log/clamav && chmod 755 /var/lib/clamav']);
    await docker(['cp',directory+'/.',container+':/var/lib/clamav/']);
    const captured=(await docker(['commit','--change','ENTRYPOINT ["/usr/sbin/clamd"]','--change','CMD ["--config-file=/etc/clamav/clamd.conf"]','--change','LABEL concord.scanner-snapshot='+id,container,tag])).toString().trim();
    if(!/^sha256:[a-f0-9]{64}$/.test(captured))throw new Error('Invalid captured scanner image');committed=true;return {image:captured,tag,manifest};
  }finally{
    let failure;try{await docker(['rm','-f','-v',container]);}catch(error){if(!error.message.includes('No such container'))failure=error;}
    await rm(temporary,{recursive:true,force:true});if(!committed||failure)await docker(['image','rm',tag]).catch(()=>{});if(failure)throw new Error('Scanner capture cleanup failed');
  }
}
export async function verifyScannerFiles(docker,container,manifest){
  const checked=scannerManifestSchema.parse(manifest);
  const names=(await docker(['exec',container,'find','/var/lib/clamav','-maxdepth','1','-type','f'])).toString().trim().split('\n').map(n=>path.posix.basename(n)).sort();
  if(JSON.stringify(names)!==JSON.stringify(checked.files.map(f=>f.name).sort()))throw new Error('Restored scanner file set mismatch');
  for(const file of checked.files){
    const target='/var/lib/clamav/'+file.name,bytes=Number((await docker(['exec',container,'stat','-c','%s',target])).toString().trim()),sha=(await docker(['exec',container,'sha256sum',target])).toString().split(/\s+/)[0];
    if(bytes!==file.bytes||sha!==file.sha256)throw new Error('Restored scanner definition digest mismatch');
  }
}
