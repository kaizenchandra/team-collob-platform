"use client";
import {useCallback,useEffect,useRef,useState} from 'react';
import {z} from 'zod';
import {API,ApiError,api} from '@/lib/contracts';
import {uploadFile,type UploadProgress} from '@/lib/upload-file';
import {UploadProgressView} from './upload-progress';
import {FileProcessing} from './file-processing';
import {Modal} from './primitives';
const historySchema=z.object({canUpload:z.boolean(),versions:z.array(z.object({id:z.uuid(),name:z.string(),state:z.string(),revision_number:z.number().int().positive(),created_at:z.string(),scan_status:z.string().nullable()})).max(100)});
type History=z.infer<typeof historySchema>;
export function FileVersionsDialog({userId,stream,file,onClose}:{userId:string;stream:string;file:{id:string;name:string};onClose:()=>void}){
  return <Modal title={`Versions: ${file.name}`} onClose={onClose}><div className="modal-body"><FileVersionsContent key={`${userId}:${stream}:${file.id}`} userId={userId} stream={stream} file={file}/></div></Modal>;
}
export function FileVersionsContent({userId,stream,file}:{userId:string;stream:string;file:{id:string;name:string}}){
  const mounted=useRef(true),request=useRef<AbortController|null>(null),mutation=useRef<AbortController|null>(null),mutating=useRef(false);
  const [history,setHistory]=useState<History|null>(null),[error,setError]=useState(''),[mutationError,setMutationError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[loading,setLoading]=useState(true);
  const [uploadProgress,setUploadProgress]=useState<UploadProgress|null>(null);
  const load=useCallback(async()=>{
    request.current?.abort();const controller=new AbortController();request.current=controller;
    try{const result=historySchema.parse(await api(`/channels/${stream}/files/${file.id}/versions`,'GET',undefined,AbortSignal.any([controller.signal,AbortSignal.timeout(8000)])));if(mounted.current&&!controller.signal.aborted){setHistory(result);setError('');}}
    catch(e){if(mounted.current&&!controller.signal.aborted){setHistory(null);setError(e instanceof Error?e.message:'History unavailable');}}
    finally{if(request.current===controller){request.current=null;if(mounted.current)setLoading(false);}}
  },[stream,file.id]);
  useEffect(()=>{
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Hydrate the scoped remote version history.
    mounted.current=true;void load();const timer=setInterval(()=>{if(!request.current&&!mutating.current)void load();},3000);
    return()=>{mounted.current=false;request.current?.abort();mutation.current?.abort();clearInterval(timer);};
  },[load]);
  async function mutate(action:(signal:AbortSignal)=>Promise<unknown>,kind:'upload'|'retry'){
    if(mutating.current)return;
    mutating.current=true;setBusy(true);setMutationError('');setNotice('');setUploadProgress(null);request.current?.abort();const controller=new AbortController();mutation.current=controller;
    try{await action(AbortSignal.any([controller.signal,AbortSignal.timeout(20000)]));if(mounted.current&&!controller.signal.aborted){setUploadProgress(null);setNotice(kind==='upload'?'Version upload accepted.':'Scan retry requested.');setLoading(true);await load();}}
    catch(e){if(mounted.current&&!controller.signal.aborted){if(e instanceof ApiError&&[401,403,404].includes(e.status))setHistory(null);setMutationError(e instanceof ApiError?e.message:kind==='upload'?'Version upload could not be confirmed. Reselect the same file to retry safely. Current versions refresh automatically.':'Scan retry could not be confirmed. Current results refresh automatically.');}}
    finally{if(mutation.current===controller){mutation.current=null;mutating.current=false;if(mounted.current){setBusy(false);setUploadProgress(null);}}}
  }
  return <>
    <p>Each version is scanned separately. Existing message links keep their original version. Only the original uploader can add versions, with the same filename and format.</p>
    {error&&<div role="alert"><p>{error}</p><button className="secondary" disabled={busy||loading} onClick={()=>{setLoading(true);setError('');void load();}}>Retry history</button></div>}
    {loading&&<p role="status">Loading versions…</p>}
    {notice&&<p role="status">{notice}</p>}
    {mutationError&&<p role="alert">{mutationError}</p>}
    <UploadProgressView value={uploadProgress}/>
    {history?.canUpload&&<label className="primary upload-button">{busy?'Working…':'Upload new version'}<input aria-label="Upload new version" type="file" disabled={busy||loading||!history.versions.some(v=>v.revision_number===1&&v.state==='ready')} onChange={async e=>{
      const input=e.currentTarget,selected=input.files?.[0];if(!selected)return;
      try{await mutate(signal=>uploadFile(selected,userId,stream,file.id,signal,value=>{if(mounted.current&&!signal.aborted)setUploadProgress(value);}),'upload');}finally{input.value='';}
    }}/></label>}
    {history&&<p>Reselect the same file after an interrupted upload to retry safely, including after reload. Maximum 100 versions.</p>}
    {history?.versions.map(v=><div className="file-row" key={v.id}>
      <div><strong>Version {v.revision_number}</strong><small>{v.state} · scan {v.scan_status} · {new Date(v.created_at).toLocaleString()}</small><FileProcessing state={v.state} status={v.scan_status}/></div>
      {v.state==='ready'&&<a className="secondary" aria-label={`Download version ${v.revision_number}`} href={`${API}/v1/channels/${stream}/files/${v.id}/download`}>Download</a>}
      {history.canUpload&&v.state==='quarantined'&&v.scan_status==='dead'&&<button className="secondary" disabled={busy||loading} onClick={()=>void mutate(signal=>api(`/channels/${stream}/files/${v.id}/retry`,'POST',{},signal),'retry')}>Retry scan</button>}
    </div>)}
  </>;
}
