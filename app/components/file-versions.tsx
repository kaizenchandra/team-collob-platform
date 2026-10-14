"use client";
import {useEffect,useState} from 'react';
import {API,api} from '@/lib/contracts';
import {uploadFile} from '@/lib/upload-file';
import {Modal} from './primitives';
type History={canUpload:boolean;versions:{id:string;name:string;state:string;revision_number:number;created_at:string;scan_status:string}[]};
export function FileVersionsDialog({userId,stream,file,onClose}:{userId:string;stream:string;file:{id:string;name:string};onClose:()=>void}){
  const [history,setHistory]=useState<History|null>(null),[error,setError]=useState(''),[uploadError,setUploadError]=useState(''),[busy,setBusy]=useState(false),[attempt,setAttempt]=useState(0);
  useEffect(()=>{
    let active=true,pending=false;
    const controller=new AbortController();
    const refresh=async()=>{
      if(pending)return;pending=true;
      try{const result=await api<History>(`/channels/${stream}/files/${file.id}/versions`,'GET',undefined,AbortSignal.any([controller.signal,AbortSignal.timeout(8000)]));if(active){setHistory(result);setError('');}}
      catch(e){if(active){setHistory(null);setError(e instanceof Error?e.message:'History unavailable');}}
      finally{pending=false;}
    };
    void refresh();const timer=setInterval(()=>void refresh(),3000);
    return()=>{active=false;controller.abort();clearInterval(timer);};
  },[stream,file.id,attempt]);
  return <Modal title={`Versions: ${file.name}`} onClose={onClose}><div className="modal-body">
    <p>Each version is scanned separately. Existing message links keep their original version. Only the original uploader can add versions, with the same filename and format.</p>
    {error && <div role="alert"><p>{error}</p><button className="secondary" onClick={()=>setAttempt(n=>n+1)}>Retry history</button></div>}
    {!history && !error && <p role="status">Loading versions…</p>}
    {uploadError && <p role="alert">{uploadError}</p>}
    {history?.canUpload && <label className="primary upload-button">{busy?'Uploading…':'Upload new version'}<input aria-label="Upload new version" type="file" disabled={busy || !history.versions.some(v=>v.revision_number===1 && v.state==='ready')} onChange={async e=>{
      const input=e.currentTarget,selected=input.files?.[0];if(!selected)return;setBusy(true);setUploadError('');
      try{await uploadFile(selected,userId,stream,file.id);setAttempt(n=>n+1);}
      catch(e){setUploadError(e instanceof Error?e.message:'Upload failed. Reselect the same file to retry safely.');}
      finally{input.value='';setBusy(false);}
    }}/></label>}
    {history && <p>Reselect the same file after an interrupted upload to retry safely, including after reload. Maximum 100 versions.</p>}
    {history?.versions.map(v=><div className="file-row" key={v.id}>
      <div><strong>Version {v.revision_number}</strong><small>{v.state} · scan {v.scan_status} · {new Date(v.created_at).toLocaleString()}</small></div>
      {v.state==='ready' && <a className="secondary" aria-label={`Download version ${v.revision_number}`} href={`${API}/v1/channels/${stream}/files/${v.id}/download`}>Download</a>}
      {history.canUpload && v.state==='quarantined' && v.scan_status==='dead' && <button className="secondary" onClick={async()=>{try{await api(`/channels/${stream}/files/${v.id}/retry`,'POST',{});setAttempt(n=>n+1);}catch(e){setError(e instanceof Error?e.message:'Retry failed');}}}>Retry scan</button>}
    </div>)}
  </div></Modal>;
}
