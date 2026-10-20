import {postUpload,type UploadProgress} from './upload-request';
export type {UploadProgress} from './upload-request';
import {beginUpload,finishUpload} from './pending-uploads';

export async function uploadFile(file: File, userId: string, stream: string, versionOf?: string, signal?: AbortSignal, progress?:(value:UploadProgress)=>void) {
  signal?.throwIfAborted();
  if(file.size>1048576)throw new Error('Local uploads are limited to 1 MB.');
  const report=(value:UploadProgress)=>{if(!signal?.aborted)progress?.(value);};
  report({phase:'reading',loaded:0,total:file.size});
  const data=await new Promise<string>((resolve,reject)=>{
    const reader=new FileReader();
    reader.onprogress=event=>report({phase:'reading',loaded:event.loaded,total:event.lengthComputable?event.total:null});
    reader.onload=()=>resolve(String(reader.result).split(',')[1]);
    reader.onerror=()=>reject(new Error('Could not read the selected file.'));
    reader.readAsDataURL(file);
  });
  signal?.throwIfAborted();report({phase:'preparing'});
  const mime=file.type || 'application/octet-stream';
  const digest=async(bytes:BufferSource)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join('');
  const hash=await digest(await file.arrayBuffer());
  const identity=versionOf?[file.name,mime,hash,versionOf]:[file.name,mime,hash];
  const fingerprint=await digest(new TextEncoder().encode(JSON.stringify(identity)));
  signal?.throwIfAborted();
  const clientId=beginUpload(window.sessionStorage,userId,stream,fingerprint);
  await postUpload(`/channels/${stream}/files`,{clientId,name:file.name,mime,content:data,...(versionOf?{versionOf}:{})},AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(20000)]),report);
  report({phase:'accepted'});
  finishUpload(window.sessionStorage,clientId);
}
