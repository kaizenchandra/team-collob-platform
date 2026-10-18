"use client";
import {useRef,useState,useEffect} from 'react';
import {z} from 'zod';
import {api} from '@/lib/contracts';
const cursor=z.object({createdAt:z.iso.datetime(),id:z.uuid()});
const snapshot=z.object({files:z.array(z.object({id:z.uuid(),name:z.string(),bytes:z.string(),revision_root:z.uuid().nullable(),revision_number:z.number().int().positive(),lifecycle_revision:z.number().int().positive()})).max(100),hasMore:z.boolean(),nextCursor:cursor.nullable()}).refine(v=>v.hasMore===(v.nextCursor!==null),'Invalid recovery page boundary');
type Cursor=z.infer<typeof cursor>;
type Snapshot=z.infer<typeof snapshot>;
export function FileRecovery({stream,onRestored}:{stream:string;onRestored:()=>Promise<void>}){
  const [data,setData]=useState<Snapshot|null>(null),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[selected,setSelected]=useState<Snapshot['files'][number]|null>(null);
  const [history,setHistory]=useState<(Cursor|null)[]>([null]);
  const active=useRef(true),request=useRef<AbortController|null>(null);
  useEffect(()=>{active.current=true;return()=>{active.current=false;request.current?.abort();};},[]);
  async function load(nextHistory:(Cursor|null)[]=[null],refresh=false){
    request.current?.abort();const controller=new AbortController();request.current=controller;
    setBusy(true);setError('');setNotice('');setSelected(null);if(refresh){setData(null);setHistory([null]);}
    const before=nextHistory.at(-1),query=before?'?'+new URLSearchParams({beforeCreated:before.createdAt,beforeId:before.id}).toString():'';
    try{const next=snapshot.parse(await api(`/channels/${stream}/deleted-files${query}`,'GET',undefined,AbortSignal.any([controller.signal,AbortSignal.timeout(8000)])));if(active.current&&!controller.signal.aborted){setData(next);setHistory(nextHistory);}}
    catch(e){if(active.current&&!controller.signal.aborted)setError(e instanceof Error?e.message:'Deleted files unavailable');}
    finally{if(active.current&&request.current===controller){request.current=null;setBusy(false);}}
  }
  return <section aria-label="Deleted file recovery">
    <h3>Your deleted files</h3>
    <p>Restore files you uploaded in this conversation. Each file needs a new malware scan before anyone can open it. Restore the original before its versions; versions are recovered separately.</p>
    <p>Browse up to 100 files per page, newest first. Refresh returns to the newest page. The list can change while you browse.</p>
    <button className="secondary" disabled={busy} onClick={()=>void load([null],true)}>Refresh deleted files</button>
    {busy&&<p role="status">Loading…</p>}
    {error&&<p role="alert">{error}</p>}
    {notice&&<p role="status">{notice}</p>}
    {data&&<nav aria-label="Deleted file pages"><p role="status">Deleted files page {history.length} · {data.files.length} {data.files.length===1?'file':'files'}</p>
      <button className="secondary" disabled={busy||history.length===1} onClick={()=>void load(history.slice(0,-1))}>Newer deleted files</button>
      <button className="secondary" disabled={busy||!data.nextCursor} onClick={()=>{if(data.nextCursor)void load([...history,data.nextCursor]);}}>Older deleted files</button>
    </nav>}
    {data?.files.length===0&&<p>{history.length>1||data.hasMore?'No deleted files remain on this page. Refresh or use the page controls to continue.':'No deleted files to recover.'}</p>}
    {data?.files.map(f=><div className="file-row" key={f.id}><div><strong>{f.name}</strong><small>Version {f.revision_number} · {Math.ceil(Number(f.bytes)/1024)} KB</small></div><button className="secondary" disabled={busy} aria-label={`Restore ${f.name} version ${f.revision_number}`} onClick={()=>{setSelected(f);setNotice('');setError('');}}>Restore</button></div>)}
    {selected&&<div role="group" aria-label="Confirm file recovery"><p>Restore {selected.name}, version {selected.revision_number}? After scanning, current conversation members can open it again, including through existing message links.</p>
      <button className="primary" disabled={busy} onClick={async()=>{
        setBusy(true);setError('');
        try{
          await api(`/channels/${stream}/files/${selected.id}/restore`,'POST',{expectedRevision:selected.lifecycle_revision,confirm:true});
          if(!active.current)return;
          setData(previous=>previous?{...previous,files:previous.files.filter(f=>f.id!==selected.id)}:null);setSelected(null);setNotice('Recovery requested. A fresh malware scan is required before access is restored.');
          await onRestored();
        }catch(e){if(active.current)setError(e instanceof Error?e.message:'Recovery unavailable');}
        finally{if(active.current)setBusy(false);}
      }}>Confirm file recovery</button><button className="secondary" disabled={busy} onClick={()=>setSelected(null)}>Cancel recovery</button>
    </div>}
  </section>;
}
