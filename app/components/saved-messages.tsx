"use client";
/* Scope-keyed pages reset on refresh; replacement requests abort earlier work. */
/* eslint-disable react-hooks/set-state-in-effect */
import {useCallback,useEffect,useRef,useState} from 'react';
import {z} from 'zod';
import {ApiError,api} from '@/lib/contracts';
import {Empty} from './primitives';
const acknowledgement=z.object({ok:z.literal(true)});
const cursor=z.object({createdAt:z.iso.datetime(),id:z.uuid()});
const snapshot=z.object({messages:z.array(z.object({id:z.uuid(),channel_id:z.uuid(),channel_name:z.string(),author:z.string(),created_at:z.string(),excerpt:z.string()})).max(50),hasMore:z.boolean(),nextCursor:cursor.nullable()}).refine(value=>value.hasMore===(value.nextCursor!==null),'Invalid saved-message page boundary');
type Cursor=z.infer<typeof cursor>;
type Mode='navigate'|'refresh'|'current'|'poll';
export function SavedMessages({org,onOpen}:{org:string;onOpen:(channel:string,id:string)=>void}){
  const [page,setPage]=useState<{data:z.infer<typeof snapshot>;history:(Cursor|null)[]}|null>(null),[busy,setBusy]=useState(false),[mutating,setMutating]=useState(false);
  const [error,setError]=useState<{message:string;history:(Cursor|null)[];mode:Mode}|null>(null),[notice,setNotice]=useState('');
  const active=useRef(true),request=useRef<AbortController|null>(null),history=useRef<(Cursor|null)[]>([null]),mutation=useRef(false),write=useRef<AbortController|null>(null);
  const load=useCallback(async(nextHistory:(Cursor|null)[]=history.current,mode:Mode='current')=>{
    request.current?.abort();const controller=new AbortController();request.current=controller;
    if(mode!=='poll'){setBusy(true);setError(null);}
    if(mode==='refresh'){history.current=[null];setPage(null);}
    const before=nextHistory.at(-1),query=before?'?'+new URLSearchParams({beforeCreated:before.createdAt,beforeId:before.id}):'';
    try{
      const data=snapshot.parse(await api(`/organizations/${org}/saved-messages${query}`,'GET',undefined,AbortSignal.any([controller.signal,AbortSignal.timeout(8000)])));
      if(active.current&&!controller.signal.aborted){history.current=nextHistory;setPage({data,history:nextHistory});setError(previous=>mode==='poll'&&previous?.mode==='navigate'?previous:null);}
    }catch(e){if(active.current&&!controller.signal.aborted){
      if(mode!=='navigate'||e instanceof ApiError&&[401,403,404].includes(e.status))setPage(null);
      const message=e instanceof Error?e.message:'Saved messages unavailable';
      // A failed background read must keep the user's pending page retry target.
      setError(previous=>mode==='poll'&&previous?.mode==='navigate'?{...previous,message}:{message,history:nextHistory,mode});
    }}finally{if(active.current&&request.current===controller){request.current=null;setBusy(false);}}
  },[org]);
  useEffect(()=>{
    active.current=true;void load([null],'refresh');const timer=setInterval(()=>{if(!request.current&&!mutation.current)void load(history.current,'poll');},5000);
    return()=>{active.current=false;request.current?.abort();write.current?.abort();clearInterval(timer);};
  },[load]);
  async function unsave(channel:string,id:string){
    if(mutation.current)return;
    mutation.current=true;setMutating(true);setNotice('');request.current?.abort();const controller=new AbortController();write.current=controller;
    try{
      acknowledgement.parse(await api(`/channels/${channel}/messages/${id}/save`,'POST',{saved:false},AbortSignal.any([controller.signal,AbortSignal.timeout(8000)])));
      if(active.current&&!controller.signal.aborted){setNotice('Message removed from Saved.');await load();}
    }
    catch(e){if(active.current&&!controller.signal.aborted){setPage(null);setError({message:e instanceof ApiError&&e.status<500?e.message:`${e instanceof ApiError?e.message+' ':''}Unsave could not be confirmed. Retry saved messages to check its current state before trying again.`,history:history.current,mode:'current'});}}
    finally{if(write.current===controller)write.current=null;mutation.current=false;if(active.current)setMutating(false);}
  }
  const disabled=busy||mutating;
  return <><div className="page-heading"><div><span className="eyebrow">KEEP FOR LATER</span><h1>Saved messages</h1><p>Your saved messages in this workspace.</p></div></div>
    <section className="content-pad workspace-search" aria-label="Saved messages">
      <p>Up to 50 messages per page, newest message first. Excerpts show up to 500 characters; open a message for its full content. This list can change while you browse.</p>
      <button className="secondary" disabled={disabled} onClick={()=>void load([null],'refresh')}>Refresh saved messages</button>
      {notice&&<p role="status">{notice}</p>}
      {busy&&<p role="status">Loading saved messages…</p>}
      {error&&<div role="alert"><p>{error.message}</p><button className="secondary" disabled={disabled} onClick={()=>void load(error.history,error.mode==='poll'?'current':error.mode)}>Retry saved messages</button></div>}
      {page&&<><nav aria-label="Saved message pages"><p role="status">Saved page {page.history.length} · {page.data.messages.length} {page.data.messages.length===1?'message':'messages'}</p>
        <div className="search-actions"><button className="secondary" disabled={disabled||page.history.length===1} onClick={()=>void load(page.history.slice(0,-1),'navigate')}>Newer saved messages</button>
        <button className="secondary" disabled={disabled||!page.data.nextCursor} onClick={()=>{if(page.data.nextCursor)void load([...page.history,page.data.nextCursor],'navigate');}}>Older saved messages</button></div>
      </nav>
      {page.data.messages.map(message=><article className="result-card" aria-label={`Saved message in ${message.channel_name}`} key={message.id}>
        <h2>{message.author} · #{message.channel_name}</h2><p><time dateTime={message.created_at}>{new Date(message.created_at).toLocaleString()}</time></p><p>{message.excerpt}</p>
        <div className="search-actions"><button className="secondary" disabled={disabled} onClick={()=>onOpen(message.channel_id,message.id)}>Open saved message</button><button className="secondary" disabled={disabled} onClick={()=>void unsave(message.channel_id,message.id)}>Unsave</button></div>
      </article>)}
      {!page.data.messages.length&&(page.history.length>1?<p>No saved messages remain on this page. Refresh or use the page controls to continue.</p>:<Empty title="No saved messages">Save a message from a conversation to find it here.</Empty>)}</>}
    </section></>;
}
