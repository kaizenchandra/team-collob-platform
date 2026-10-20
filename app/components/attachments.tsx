"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {z} from 'zod';
import { api, API, ApiError, type Message } from "../../lib/contracts";
const cursor=z.object({createdAt:z.iso.datetime(),id:z.uuid()});
const snapshot=z.object({files:z.array(z.object({id:z.uuid(),name:z.string(),state:z.string()})).max(100),hasMore:z.boolean(),nextCursor:cursor.nullable()}).refine(page=>page.hasMore===(page.nextCursor!==null),'Invalid attachment page boundary');
type Cursor=z.infer<typeof cursor>;
type FilePage={data:z.infer<typeof snapshot>;history:(Cursor|null)[]};
export function AttachmentPicker({channelId,select,openFiles,selectedIds=[]}:{channelId:string;select:(file:{id:string;name:string})=>void;selectedIds?:string[];openFiles:()=>void}) {
  const [page,setPage]=useState<FilePage|null>(null),[busy,setBusy]=useState(true),[error,setError]=useState<{message:string;history:(Cursor|null)[]}|null>(null);
  const active=useRef(true),request=useRef<AbortController|null>(null);
  const load=useCallback(async(history:(Cursor|null)[]=[null])=>{
    request.current?.abort();const controller=new AbortController();request.current=controller;setBusy(true);setError(null);
    const before=history.at(-1),query=before?'?'+new URLSearchParams({beforeCreated:before.createdAt,beforeId:before.id}).toString():'';
    try{const data=snapshot.parse(await api(`/channels/${channelId}/files${query}`,'GET',undefined,AbortSignal.any([controller.signal,AbortSignal.timeout(8000)])));if(active.current&&!controller.signal.aborted)setPage({data,history});}
    catch(e){if(active.current&&!controller.signal.aborted){setPage(null);setError({message:e instanceof ApiError?e.message:'Files could not be loaded. Check your access and retry.',history});}}
    finally{if(active.current&&request.current===controller){request.current=null;setBusy(false);}}
  },[channelId]);
  useEffect(()=>{
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Hydrate the scoped remote attachment page.
    active.current=true;void load();return()=>{active.current=false;request.current?.abort();};
  },[load]);
  return <div className="modal-body attachment-picker">
    <p>Add scanned files to your draft, then review them before sending. Only people with access to this conversation can download it.</p>
    <p>Browse up to 100 files per page, newest first. Refresh returns to the newest page. Selecting a ready file does not send a message.</p>
    <div className="attachment-actions"><button className="secondary" type="button" onClick={openFiles}>Upload in Files</button>
    <button className="secondary" type="button" disabled={busy} onClick={()=>void load()}>Refresh files</button></div>
    {busy&&<p role="status">Loading files…</p>}
    {error&&<div role="alert"><p>{error.message}</p><button className="secondary" type="button" disabled={busy} onClick={()=>void load(error.history)}>Retry files</button></div>}
    {page&&<>
      <nav aria-label="Attachment file pages"><p role="status">Attachment files page {page.history.length} · {page.data.files.length} {page.data.files.length===1?'file':'files'}</p>
        <div className="attachment-actions"><button className="secondary" type="button" disabled={busy||page.history.length===1} onClick={()=>void load(page.history.slice(0,-1))}>Newer files</button>
        <button className="secondary" type="button" disabled={busy||!page.data.nextCursor} onClick={()=>{if(page.data.nextCursor)void load([...page.history,page.data.nextCursor]);}}>Older files</button></div>
      </nav>
      {!page.data.files.length&&<p>{page.history.length>1?'No files remain on this page. Refresh or use the page controls to continue.':'No files yet. Upload a file and wait for its scan to finish.'}</p>}
      {page.data.files.map(f=><div className="file-row" key={f.id}><span>{f.name}</span>{f.state==="ready" ? <button className="secondary" type="button" disabled={busy||selectedIds.includes(f.id)} onClick={()=>select({id:f.id,name:f.name})} aria-label={`${selectedIds.includes(f.id)?"Already added":"Add file"} ${f.name}`}>{selectedIds.includes(f.id)?"Added":"Add file"}</button> : <span>Unavailable — {f.state}</span>}</div>)}
    </>}
  </div>;
}
export function MessageAttachments({channelId,attachments}:{channelId:string;attachments:Message["attachments"]}) {
  if(!attachments.length)return null;
  return <ul aria-label="Message attachments">{attachments.map(f=><li key={f.id}>{f.state==="ready" && f.name ? <a href={`${API}/v1/channels/${channelId}/files/${f.id}/download`} download>{f.name}</a> : <span>Attachment unavailable</span>}</li>)}</ul>;
}
