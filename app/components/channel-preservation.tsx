"use client";
import {useCallback,useEffect,useId,useRef,useState} from 'react';
import {z} from 'zod';
import {api} from '@/lib/contracts';
const schema=z.object({id:z.uuid(),active:z.boolean(),reason:z.string().max(500),revision:z.number().int().nonnegative()});
type Snapshot=z.infer<typeof schema>;
export function ChannelPreservation({id}:{id:string}){
  const [data,setData]=useState<Snapshot|null>(null),[reason,setReason]=useState(''),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[loading,setLoading]=useState(true),[confirming,setConfirming]=useState(false);
  const field=useId(),mounted=useRef(true),request=useRef<AbortController|null>(null);
  const load=useCallback(async()=>{
    request.current?.abort();const controller=new AbortController();request.current=controller;setLoading(true);setData(null);setError('');setNotice('');setConfirming(false);
    try{const result=schema.parse(await api(`/channels/${id}/preservation`,'GET',undefined,AbortSignal.any([controller.signal,AbortSignal.timeout(10000)])));if(result.id!==id)throw new Error('Preservation scope could not be verified');if(!controller.signal.aborted){setData(result);setReason(result.reason);}}
    catch(e){if(!controller.signal.aborted)setError(e instanceof Error?e.message:'Preservation settings unavailable');}
    finally{if(request.current===controller){request.current=null;setLoading(false);}}
  },[id]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- Load the resource-keyed authoritative owner snapshot.
  useEffect(()=>{mounted.current=true;void load();return()=>{mounted.current=false;request.current?.abort();};},[load]);
  return <section aria-label="Message and file preservation"><h3>Message and file preservation</h3>
    <p>Workspace owners with channel access can block message edits, message removal (including moderation removal) and file deletion. New posts, uploads and scanned file recovery remain available. This does not recover previously deleted message text or freeze other content.</p>
    <button className="secondary" disabled={busy||loading} onClick={()=>void load()}>Refresh preservation settings</button>
    {loading&&<p role="status">Loading preservation settings…</p>}{error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
    {data&&<><p>Preservation hold: <strong>{data.active?'Active':'Inactive'}</strong></p>
      <label htmlFor={field}>Preservation reason</label><textarea id={field} maxLength={500} disabled={busy||confirming} value={reason} onChange={e=>setReason(e.target.value)}/>
      <p>The current note is visible only to workspace owners who can access this channel. Refresh replaces unsaved changes.</p>
      {!confirming&&<button className="secondary" disabled={busy||(!data.active&&!reason.trim())} onClick={()=>{setConfirming(true);setNotice('');setError('');}}>{data.active?'Review hold release':'Review preservation hold'}</button>}
      {confirming&&<div role="group" aria-label="Confirm preservation change"><p>{data.active?'Release this hold? Message edits, message removal and file deletion will be allowed again under existing permissions.':'Apply this hold? Existing and new messages and files will be protected from these edits and deletions until an authorized owner releases it.'}</p>
        <button className="primary" disabled={busy} onClick={async()=>{
          setBusy(true);setError('');
          try{const result=schema.parse(await api(`/channels/${id}/preservation`,'PUT',{active:!data.active,reason,expectedRevision:data.revision,confirm:true}));if(result.id!==id)throw new Error('Preservation scope could not be verified');if(mounted.current){setData(result);setReason(result.reason);setConfirming(false);setNotice(result.active?'Preservation hold applied.':'Preservation hold released.');}}
          catch(e){if(mounted.current)setError(e instanceof Error?e.message:'Preservation change could not be confirmed. Refresh before retrying.');}
          finally{if(mounted.current)setBusy(false);}
        }}>{data.active?'Confirm hold release':'Confirm preservation hold'}</button><button className="secondary" disabled={busy} onClick={()=>setConfirming(false)}>Cancel preservation change</button>
      </div>}
    </>}
  </section>;
}
