"use client";
/* Remote snapshots synchronize on mount and abort on scope exit. */
/* eslint-disable react-hooks/set-state-in-effect */
import {useCallback,useEffect,useRef,useState} from 'react';
import {z} from 'zod';
import {api} from '@/lib/contracts';
import {Modal} from './primitives';
export function ConversationVisibility({id,hidden,onChanged}:{id:string;hidden:boolean;onChanged:()=>Promise<void>}){
  const mounted=useRef(true),[busy,setBusy]=useState(false),[error,setError]=useState(''),[saved,setSaved]=useState(false);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  async function update(refreshOnly=false){
    setBusy(true);setError('');let changed=refreshOnly;
    try{if(!refreshOnly){await api(`/channels/${id}/preferences`,'PATCH',{hidden:!hidden},AbortSignal.timeout(8000));changed=true;}if(mounted.current){await onChanged();if(mounted.current)setSaved(false);}}
    catch(e){if(mounted.current){setSaved(changed);setError(changed?'Visibility was updated, but the conversation list could not refresh.':e instanceof Error?e.message:'Visibility could not be updated.');}}
    finally{if(mounted.current)setBusy(false);}
  }
  return <div><p>Hiding removes this conversation from your list. Access, messages and drafts stay available.</p>
    <button className="secondary" disabled={busy||saved} onClick={()=>void update()}>{hidden?'Show conversation in list':'Hide conversation'}</button>
    {error&&<div role="alert"><p>{error}</p>{saved&&<button className="secondary" disabled={busy} onClick={()=>void update(true)}>Refresh conversation list</button>}</div>}
  </div>;
}
const snapshot=z.object({channels:z.array(z.object({id:z.uuid(),name:z.string(),kind:z.string(),hidden:z.boolean()}))});
export function HiddenConversations({org,onClose,onOpen,onChanged}:{org:string;onClose:()=>void;onOpen:(id:string)=>Promise<boolean>;onChanged:()=>Promise<void>}){
  const [data,setData]=useState<z.infer<typeof snapshot>['channels']|null>(null),[error,setError]=useState(''),[actionError,setActionError]=useState(''),[busy,setBusy]=useState(false),[sidebarError,setSidebarError]=useState(false);
  const mounted=useRef(true),request=useRef<AbortController|null>(null),working=useRef(false);
  const load=useCallback(async()=>{
    request.current?.abort();const controller=new AbortController();request.current=controller;
    try{const result=snapshot.parse(await api(`/organizations/${org}/bootstrap`,'GET',undefined,AbortSignal.any([controller.signal,AbortSignal.timeout(8000)])));if(mounted.current&&!controller.signal.aborted){setData(result.channels.filter(channel=>channel.hidden));setError('');}}
    catch(e){if(mounted.current&&!controller.signal.aborted){setData(null);setError(e instanceof Error?e.message:'Hidden conversations unavailable');}}
    finally{if(request.current===controller)request.current=null;}
  },[org]);
  useEffect(()=>{mounted.current=true;void load();const timer=setInterval(()=>{if(!request.current&&!working.current)void load();},5000);return()=>{mounted.current=false;request.current?.abort();clearInterval(timer);};},[load]);
  async function refreshSidebar(){try{await onChanged();if(mounted.current)setSidebarError(false);}catch{if(mounted.current)setSidebarError(true);}}
  async function show(id:string){
    working.current=true;setBusy(true);setActionError('');request.current?.abort();
    try{await api(`/channels/${id}/preferences`,'PATCH',{hidden:false},AbortSignal.timeout(8000));if(mounted.current){await load();if(mounted.current)await refreshSidebar();}}
    catch(e){if(mounted.current){setData(null);setActionError(e instanceof Error?e.message:'Visibility could not be updated.');}}
    finally{working.current=false;if(mounted.current)setBusy(false);}
  }
  async function open(id:string){
    working.current=true;setBusy(true);setActionError('');
    try{if(!await onOpen(id)&&mounted.current)setActionError('Conversation could not be opened. Your draft was kept.');}
    catch{if(mounted.current)setActionError('Conversation could not be opened. Try again.');}
    finally{working.current=false;if(mounted.current)setBusy(false);}
  }
  return <Modal title="Hidden conversations" onClose={onClose}><div className="modal-body linked-message">
    <p>These conversations are hidden only from your list. Opening keeps them hidden; use Show in list to bring one back. Access and drafts are unchanged.</p>
    <button className="secondary" disabled={busy} onClick={()=>void load()}>Refresh hidden conversations</button>
    {error&&<p role="alert">{error}</p>}{actionError&&<p role="alert">{actionError}</p>}
    {sidebarError&&<div role="alert"><p>Visibility was updated. The sidebar could not refresh.</p><button className="secondary" disabled={busy} onClick={()=>void refreshSidebar()}>Refresh conversation list</button></div>}
    {data===null&&!error&&!actionError&&<p role="status">Loading hidden conversations…</p>}
    {data?.length===0&&<p>No hidden conversations.</p>}
    {data?.map(channel=><article className="result-card" key={channel.id} aria-label={`Hidden ${channel.name}`}><h3>{channel.name}</h3><p>{channel.kind}</p><div className="search-actions">
      <button className="secondary" disabled={busy} onClick={()=>void open(channel.id)}>Open conversation</button><button className="secondary" disabled={busy} onClick={()=>void show(channel.id)}>Show in list</button>
    </div></article>)}
  </div></Modal>;
}
