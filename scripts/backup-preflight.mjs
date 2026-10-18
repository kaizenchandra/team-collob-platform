import {constants} from 'node:fs';
import {open} from 'node:fs/promises';
import path from 'node:path';
import {maxBytes,sha} from './backup-common.mjs';
import {decryptBackup,verifyScannerRefresh} from './scanner-refresh.mjs';
import {verifyImageArchive} from './image-archive.mjs';

async function readPrivateFile(file,limit,exactSize){
  const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
    const info=await handle.stat();
    if(!info.isFile()||(info.mode&0o077)!==0||info.size>limit||(exactSize!==undefined&&info.size!==exactSize))throw new Error('Preflight requires a private regular file within size bounds');
    const chunks=[];let bytes=0;
    for await(const chunk of handle.createReadStream({autoClose:false})){bytes+=chunk.length;if(bytes>limit)throw new Error('Preflight file exceeded size bound');chunks.push(chunk);}
    if(bytes!==info.size)throw new Error('Preflight file changed while reading');
    return Buffer.concat(chunks);
  }finally{await handle.close();}
}

export async function preflightBackup(artifactArg,keyArg){
  const artifact=path.resolve(artifactArg),key=await readPrivateFile(path.resolve(keyArg),32,32),encrypted=await readPrivateFile(artifact,maxBytes*2);
  const backup=await decryptBackup(encrypted.toString('utf8'),key),scannerRefreshVerified=await verifyScannerRefresh(backup,key);
  const companion=backup.imageArchive?await verifyImageArchive({directory:path.dirname(artifact),descriptor:backup.imageArchive,images:backup.images,key}):{imageArchiveVerified:false};
  return {artifact,version:backup.version,sha256:sha(encrypted),snapshotAt:backup.snapshotAt,envelopeVerified:true,fileBytesVerified:backup.files.length,fileBytes:backup.files.reduce((total,file)=>total+file.bytes,0),...companion,scannerRefreshVerified,restoreVerified:false,scannerRuntimeVerified:false};
}
