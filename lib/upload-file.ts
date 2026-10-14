import {api} from './contracts';
import {beginUpload,finishUpload} from './pending-uploads';

export async function uploadFile(file: File, userId: string, stream: string, versionOf?: string) {
  if(file.size>1048576)throw new Error('Local uploads are limited to 1 MB.');
  const data=await new Promise<string>((resolve,reject)=>{
    const reader=new FileReader();
    reader.onload=()=>resolve(String(reader.result).split(',')[1]);
    reader.onerror=()=>reject(new Error('Could not read the selected file.'));
    reader.readAsDataURL(file);
  });
  const mime=file.type || 'application/octet-stream';
  const digest=async(bytes:BufferSource)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join('');
  const hash=await digest(await file.arrayBuffer());
  const identity=versionOf?[file.name,mime,hash,versionOf]:[file.name,mime,hash];
  const fingerprint=await digest(new TextEncoder().encode(JSON.stringify(identity)));
  const clientId=beginUpload(window.sessionStorage,userId,stream,fingerprint);
  await api(`/channels/${stream}/files`,'POST',{clientId,name:file.name,mime,content:data,...(versionOf?{versionOf}:{})});
  finishUpload(window.sessionStorage,clientId);
}
