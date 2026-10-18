"use client";
/* Remote pages reset on resource changes; requests are aborted before replacement. */
/* eslint-disable react-hooks/set-state-in-effect */
import {useCallback,useEffect,useRef,useState} from 'react';
import {FileText,Upload} from 'lucide-react';
import {z} from 'zod';
import {API,ApiError,api} from '@/lib/contracts';
import {uploadFile} from '@/lib/upload-file';
import {previewMimeTypes} from '@/lib/file-preview';
import {Empty,Unavailable} from './primitives';
import {FileRecovery} from './file-recovery';
import {FileVersionsDialog} from './file-versions';
import {FilePreviewDialog} from './file-preview';

const cursor=z.object({createdAt:z.iso.datetime(),id:z.uuid()});
const snapshot=z.object({files:z.array(z.object({id:z.uuid(),name:z.string(),mime:z.string(),bytes:z.string(),state:z.string(),scan_status:z.string().nullable()})).max(100),hasMore:z.boolean(),nextCursor:cursor.nullable()}).refine(v=>v.hasMore===(v.nextCursor!==null),'Invalid file page boundary');
type Cursor=z.infer<typeof cursor>;
type Page={data:z.infer<typeof snapshot>;history:(Cursor|null)[]};
type Mode='navigate'|'refresh'|'current'|'poll';
export function FilesPanel({userId,stream,report}:{userId:string;stream:string;report:(error:unknown)=>void}){
  const [page,setPage]=useState<Page|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[mutationBusy,setMutationBusy]=useState(false);
  const [versions,setVersions]=useState<{id:string;name:string}|null>(null),[preview,setPreview]=useState<{id:string;name:string}|null>(null);
  const active=useRef(true),request=useRef<AbortController|null>(null),history=useRef<(Cursor|null)[]>([null]),mutating=useRef(false);
  const load=useCallback(async(nextHistory:(Cursor|null)[]=history.current,mode:Mode='current')=>{
    request.current?.abort();const controller=new AbortController();request.current=controller;
    if(mode!=='poll'){setBusy(true);setError('');}
    if(mode==='refresh'){history.current=[null];setPage(null);setVersions(null);setPreview(null);}
    const before=nextHistory.at(-1),query=before?'?'+new URLSearchParams({beforeCreated:before.createdAt,beforeId:before.id}).toString():'';
    try{
      const data=snapshot.parse(await api(`/channels/${stream}/files${query}`,'GET',undefined,AbortSignal.any([controller.signal,AbortSignal.timeout(8000)])));
      if(active.current&&!controller.signal.aborted){history.current=nextHistory;setPage({data,history:nextHistory});setError('');}
    }catch(e){
      if(active.current&&!controller.signal.aborted){
        if(mode!=='navigate'||e instanceof ApiError&&[401,403,404].includes(e.status)){setPage(null);setVersions(null);setPreview(null);}
        setError(e instanceof Error?e.message:'Files unavailable');
      }
    }finally{if(active.current&&request.current===controller){request.current=null;setBusy(false);}}
  },[stream]);
  useEffect(()=>{
    active.current=true;void load([null],'refresh');
    const timer=setInterval(()=>{if(!request.current&&!mutating.current)void load(history.current,'poll');},3000);
    return()=>{active.current=false;request.current?.abort();clearInterval(timer);};
  },[load]);
  async function mutate(action:()=>Promise<unknown>,newest=false){
    mutating.current=true;setMutationBusy(true);
    try{await action();if(active.current)await load(newest?[null]:history.current,newest?'refresh':'current');}
    catch(e){if(active.current)report(e);}
    finally{mutating.current=false;if(active.current)setMutationBusy(false);}
  }
  const disabled=busy||mutationBusy,files=page?.data.files??[];
  return <div className="content-pad">
    <section aria-label="Conversation files">
      <div className="panel-heading"><div><span className="eyebrow">SHARED IN THIS CONVERSATION</span><h2>Files</h2></div>
        <label className="primary upload-button"><Upload size={16}/>{mutationBusy?'Working…':'Upload file'}<input type="file" disabled={disabled} onChange={async e=>{
          const input=e.currentTarget,file=input.files?.[0];if(!file)return;
          try{await mutate(()=>uploadFile(file,userId,stream),true);}finally{input.value='';}
        }}/></label>
      </div>
      <Unavailable title="Scan before download">Supported: TXT, MD, CSV, PDF, PNG and JPEG up to1MB. Files stay quarantined until a real malware scan succeeds. Rejected files cannot be downloaded. Scanning may take time or remain unavailable; failed jobs can be retried by the uploader. If an upload is interrupted, reselect the same file to retry safely, including after reload. TXT, MD and CSV have source-text previews after scanning. Original files stay at version 1; use Versions to view or upload revisions. Deleting an original deletes all its versions. PDF and image previews and coauthoring remain unavailable.</Unavailable>
      <p>Browse up to 100 files per page, newest first. Refresh returns to the newest page. The list can change while you browse.</p>
      <button className="secondary" disabled={disabled} onClick={()=>void load([null],'refresh')}>Refresh files</button>
      {busy&&<p role="status">Loading files…</p>}
      {error&&<p role="alert">{error}</p>}
      {page&&<nav aria-label="File pages"><p role="status">Files page {page.history.length} · {files.length} {files.length===1?'file':'files'}</p>
        <button className="secondary" disabled={disabled||page.history.length===1} onClick={()=>void load(page.history.slice(0,-1),'navigate')}>Newer files</button>
        <button className="secondary" disabled={disabled||!page.data.nextCursor} onClick={()=>{if(page.data.nextCursor)void load([...page.history,page.data.nextCursor],'navigate');}}>Older files</button>
      </nav>}
      {files.map(f=><div className="file-row" key={f.id}>
        <FileText size={24}/><div><strong>{f.name}</strong><small>{Math.ceil(Number(f.bytes)/1024)} KB · {f.state} · scan {f.scan_status}</small></div>
        <button className="secondary" disabled={disabled} onClick={()=>setVersions({id:f.id,name:f.name})}>Versions</button>
        {f.state==='ready'&&(previewMimeTypes.includes(f.mime)?<button className="secondary" disabled={disabled} onClick={()=>setPreview({id:f.id,name:f.name})}>Preview</button>:<small>Preview unavailable for this format</small>)}
        {f.state==='ready'&&<a className="secondary" href={`${API}/v1/channels/${stream}/files/${f.id}/download`}>Download</a>}
        {f.state==='quarantined'&&f.scan_status==='dead'&&<button className="secondary" disabled={disabled} onClick={()=>void mutate(()=>api(`/channels/${stream}/files/${f.id}/retry`,'POST',{}))}>Retry scan</button>}
        <button className="secondary" disabled={disabled} onClick={()=>void mutate(()=>api(`/channels/${stream}/files/${f.id}`,'DELETE'))}>Delete</button>
      </div>)}
      {page&&files.length===0&&(page.history.length>1?<p>No files remain on this page. Refresh or use the page controls to continue.</p>:<Empty title="Everything in its place">Files uploaded to this channel appear here with their processing status.</Empty>)}
    </section>
    <FileRecovery key={stream} stream={stream} onRestored={()=>load()}/>
    {versions&&<FileVersionsDialog key={versions.id} userId={userId} stream={stream} file={versions} onClose={()=>setVersions(null)}/>}
    {preview&&<FilePreviewDialog key={preview.id} stream={stream} file={preview} onClose={()=>setPreview(null)}/>}
  </div>;
}
