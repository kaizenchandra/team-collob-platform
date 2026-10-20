"use client";
import {useRef,useState,useEffect} from 'react';
import {z} from 'zod';
import {ApiError,api} from '@/lib/contracts';
const cursor=z.object({createdAt:z.iso.datetime(),id:z.uuid()});
const snapshot=z.object({files:z.array(z.object({id:z.uuid(),name:z.string(),bytes:z.string(),revision_root:z.uuid().nullable(),revision_number:z.number().int().positive(),lifecycle_revision:z.number().int().positive()})).max(100),hasMore:z.boolean(),nextCursor:cursor.nullable()}).refine(v=>v.hasMore===(v.nextCursor!==null),'Invalid recovery page boundary');
type Cursor=z.infer<typeof cursor>;
type Snapshot=z.infer<typeof snapshot>;
export function FileRecovery({stream,onRestored}:{stream:string;onRestored:()=>Promise<void>}){
  const [data,setData]=useState<Snapshot|null>(null),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[selected,setSelected]=useState<Snapshot['files'][number]|null>(null);
  const [history,setHistory]=useState<(Cursor|null)[]>([null]);
  const [readError,setReadError]=useState<{message:string;history:(Cursor|null)[]}|null>(null);
  const active=useRef(true),request=useRef<AbortController|null>(null),mutation=useRef<AbortController|null>(null),mutating=useRef(false);
  useEffect(()=>{active.current=true;return()=>{active.current=false;request.current?.abort();mutation.current?.abort();};},[]);
  async function load(nextHistory:(Cursor|null)[]=[null],refresh=false){
    if(mutating.current)return;
    request.current?.abort();const controller=new AbortController();request.current=controller;
    setBusy(true);setError('');setReadError(null);setNotice('');setSelected(null);if(refresh){setData(null);setHistory([null]);}
    const before=nextHistory.at(-1),query=before?'?'+new URLSearchParams({beforeCreated:before.createdAt,beforeId:before.id}).toString():'';
    try{const next=snapshot.parse(await api(`/channels/${stream}/deleted-files${query}`,'GET',undefined,AbortSignal.any([controller.signal,AbortSignal.timeout(8000)])));if(active.current&&!controller.signal.aborted){setData(next);setHistory(nextHistory);}}
    catch(e){if(active.current&&!controller.signal.aborted){setData(null);setSelected(null);setReadError({message:e instanceof ApiError?e.message:'Deleted files could not be loaded. Retry deleted files or refresh to the newest page.',history:nextHistory});}}
    finally{if(active.current&&request.current===controller){request.current=null;setBusy(false);}}
  }
  return <section aria-label="Deleted file recovery">
    <h3>Your deleted files</h3>
    <p>Restore files you uploaded in this conversation. Each file needs a new malware scan before anyone can open it. Restore the original before its versions; versions are recovered separately.</p>
    <p>Browse up to 100 files per page, newest first. Refresh returns to the newest page. The list can change while you browse.</p>
    <button className="secondary" disabled={busy} onClick={()=>void load([null],true)}>Refresh deleted files</button>
    {busy&&<p role="status">Loading…</p>}
    {error&&<p role="alert">{error}</p>}
    {readError&&<><p role="alert">{readError.message}</p><button className="secondary" disabled={busy} onClick={()=>void load(readError.history)}>Retry deleted files</button></>}
    {notice&&<p role="status">{notice}</p>}
    {data&&<nav aria-label="Deleted file pages"><p role="status">Deleted files page {history.length} · {data.files.length} {data.files.length===1?'file':'files'}</p>
      <button className="secondary" disabled={busy||history.length===1} onClick={()=>void load(history.slice(0,-1))}>Newer deleted files</button>
      <button className="secondary" disabled={busy||!data.nextCursor} onClick={()=>{if(data.nextCursor)void load([...history,data.nextCursor]);}}>Older deleted files</button>
    </nav>}
    {data?.files.length===0&&<p>{history.length>1||data.hasMore?'No deleted files remain on this page. Refresh or use the page controls to continue.':'No deleted files to recover.'}</p>}
    {data?.files.map(f=><div className="file-row" key={f.id}><div><strong>{f.name}</strong><small>Version {f.revision_number} · {Math.ceil(Number(f.bytes)/1024)} KB</small></div><button className="secondary" disabled={busy} aria-label={`Restore ${f.name} version ${f.revision_number}`} onClick={()=>{setSelected(f);setNotice('');setError('');}}>Restore</button></div>)}
    {selected&&<div role="group" aria-label="Confirm file recovery"><p>Restore {selected.name}, version {selected.revision_number}? After scanning, current conversation members can open it again, including through existing message links.</p>
      <button className="primary" disabled={busy} onClick={async()=>{
        if(mutating.current)return;
        mutating.current=true;request.current?.abort();request.current=null;
        const controller=new AbortController();mutation.current=controller;
        setBusy(true);setError('');setNotice('');
        try{
          await api(`/channels/${stream}/files/${selected.id}/restore`,'POST',{expectedRevision:selected.lifecycle_revision,confirm:true},AbortSignal.any([controller.signal,AbortSignal.timeout(20000)]));
          if(!active.current||controller.signal.aborted)return;
          setData(previous=>previous?{...previous,files:previous.files.filter(f=>f.id!==selected.id)}:null);setSelected(null);setNotice('Recovery requested. A fresh malware scan is required before access is restored.');
          try{await onRestored();}catch{if(active.current&&!controller.signal.aborted)setError('File list unavailable. Refresh files to check scan progress.');}
        }catch(e){
          if(active.current&&!controller.signal.aborted){
            setSelected(null);
            if(e instanceof ApiError){setError(e.message);if([401,403,404].includes(e.status))setData(null);}
            else{setData(null);setError('Recovery could not be confirmed. Refresh deleted files to check current state before trying again.');}
          }
        }finally{if(mutation.current===controller){mutation.current=null;mutating.current=false;if(active.current)setBusy(false);}}
      }}>Confirm file recovery</button><button className="secondary" disabled={busy} onClick={()=>setSelected(null)}>Cancel recovery</button>
    </div>}
  </section>;
}
