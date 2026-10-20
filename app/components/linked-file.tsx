"use client";
import {useEffect,useRef,useState} from 'react';
import {z} from 'zod';
import {API,api} from '@/lib/contracts';
import {fileLink,type FileLinkTarget} from '@/lib/file-link';
import {previewMimeTypes} from '@/lib/file-preview';
import {FileVersionsContent} from './file-versions';
import {FilePreviewContent} from './file-preview';
import {FileProcessing} from './file-processing';
import {Modal} from './primitives';
const snapshot=z.object({channel:z.object({id:z.uuid(),name:z.string()}),file:z.object({id:z.uuid(),name:z.string(),mime:z.string(),bytes:z.string(),state:z.string(),created_at:z.string(),scan_status:z.string().nullable()})});
export function LinkedFile({target,userId,onClose}:{target:FileLinkTarget;userId:string;onClose:()=>void}){
  const mounted=useRef(true),copying=useRef(false),readGeneration=useRef(0);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  const [copyBusy,setCopyBusy]=useState(false);
  const [notice,setNotice]=useState(''),[showPreview,setShowPreview]=useState(false),[showVersions,setShowVersions]=useState(false);
  const [data,setData]=useState<z.infer<typeof snapshot>|null>(null),[error,setError]=useState(''),[attempt,setAttempt]=useState(0);
  useEffect(()=>{
    let active=true,pending=false;const controller=new AbortController();
    async function refresh(){
      if(pending)return;pending=true;
      try{
        const result=snapshot.parse(await api(`/organizations/${target.org}/channels/${target.channel}/files/${target.id}`,'GET',undefined,AbortSignal.any([controller.signal,AbortSignal.timeout(8000)])));
        if(result.channel.id!==target.channel||result.file.id!==target.id)throw new Error('File response did not match this selection');
        if(active){setData(result);setError('');if(result.file.state!=='ready'||!previewMimeTypes.includes(result.file.mime))setShowPreview(false);}
      }catch(e){if(active){readGeneration.current++;setData(null);setNotice('');setShowPreview(false);setShowVersions(false);setError(e instanceof Error?e.message:'File unavailable');}}
      finally{pending=false;}
    }
    void refresh();const timer=setInterval(()=>void refresh(),5000);
    return()=>{active=false;controller.abort();clearInterval(timer);};
  },[target.org,target.channel,target.id,attempt]);
  return <Modal title="Selected file" onClose={onClose}><div className="modal-body linked-message">
    <p>This is the selected original file. Downloads become available after a successful malware scan.</p>
    {!data&&!error&&<p role="status">Loading file…</p>}
    {error&&<div role="alert"><p>{error}</p><button className="secondary" onClick={()=>{setError('');setAttempt(value=>value+1);}}>Retry file</button></div>}
    {notice&&<p role="status">{notice}</p>}
    {data&&<article aria-label="Selected file details"><h3>{data.file.name}</h3><p>#{data.channel.name}</p>
      <p>{data.file.mime} · {Number(data.file.bytes).toLocaleString()} bytes · {data.file.state} · scan {data.file.scan_status??'unavailable'}</p><FileProcessing state={data.file.state} status={data.file.scan_status}/>
      <p>Uploaded <time dateTime={data.file.created_at}>{new Date(data.file.created_at).toLocaleString()}</time></p>
      {data.file.state==='ready'?<a className="secondary" href={`${API}/v1/channels/${target.channel}/files/${target.id}/download`}>Download selected file</a>:<p>Download unavailable.</p>}
      {data.file.state==='ready'&&previewMimeTypes.includes(data.file.mime)&&<>
        <p><button className="secondary" aria-expanded={showPreview} onClick={()=>setShowPreview(value=>!value)}>{showPreview?'Hide file preview':'Preview selected file'}</button></p>
        {showPreview&&<section aria-label="Selected file preview"><h4>Source preview</h4><FilePreviewContent key={target.id} stream={target.channel} file={data.file}/></section>}
      </>}
      <p><button className="secondary" disabled={copyBusy} onClick={async()=>{
        if(copying.current)return;copying.current=true;setCopyBusy(true);setNotice('');const generation=readGeneration.current;
        try{await navigator.clipboard.writeText(fileLink(window.location.origin,target));if(mounted.current&&generation===readGeneration.current)setNotice('File link copied.');}
        catch{if(mounted.current&&generation===readGeneration.current)setNotice('Clipboard unavailable. Try copying the link again.');}
        finally{copying.current=false;if(mounted.current)setCopyBusy(false);}
      }}>Copy file link</button></p>
      <p><button className="secondary" aria-expanded={showVersions} onClick={()=>setShowVersions(value=>!value)}>{showVersions?'Hide versions':'View versions'}</button></p>
      {showVersions&&<section aria-label="Selected file versions"><h4>Version history</h4><FileVersionsContent key={`${userId}:${target.id}`} userId={userId} stream={target.channel} file={data.file}/></section>}
    </article>}
  </div></Modal>;
}
