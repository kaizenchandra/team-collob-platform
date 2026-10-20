"use client";
/* Scoped replacement reads own their cancellation and explicit retry target. */
/* eslint-disable react-hooks/set-state-in-effect */
import {useCallback,useEffect,useRef,useState} from 'react';
import {z} from 'zod';
import {api,ApiError} from '@/lib/contracts';
import type {MessageLinkTarget} from '@/lib/message-link';
import {Modal} from './primitives';
const snapshot=z.object({channel:z.object({id:z.uuid(),name:z.string()}),message:z.object({id:z.uuid(),created_at:z.iso.datetime({offset:true}),excerpt:z.string().max(1000).refine(value=>Array.from(value).length<=500)}),readers:z.array(z.object({id:z.uuid(),name:z.string().min(1).max(500)})).max(50),hasMore:z.boolean(),nextCursor:z.uuid().nullable()}).refine(page=>page.hasMore===(page.nextCursor!==null)&&(!page.hasMore||page.readers.length===50&&page.nextCursor===page.readers.at(-1)?.id)&&new Set(page.readers.map(reader=>reader.id)).size===page.readers.length&&page.readers.every((reader,index)=>index===0||reader.id>page.readers[index-1].id),'Invalid message reader page');
type Page=z.infer<typeof snapshot>;
export function MessageReaders({target,onClose}:{target:MessageLinkTarget;onClose:()=>void}){
  const [page,setPage]=useState<{data:Page;history:(string|null)[]}|null>(null),[busy,setBusy]=useState(true),[error,setError]=useState<{message:string;history:(string|null)[]}|null>(null);
  const active=useRef(true),request=useRef<AbortController|null>(null),history=useRef<(string|null)[]>([null]),failed=useRef(false);
  const load=useCallback(async(next:(string|null)[]=history.current,poll=false)=>{
    request.current?.abort();const controller=new AbortController();request.current=controller;setBusy(true);setError(null);failed.current=false;if(!poll)setPage(null);
    const after=next.at(-1),query=after?'?'+new URLSearchParams({afterId:after}):'';
    try{
      const data=snapshot.parse(await api(`/organizations/${target.org}/channels/${target.channel}/messages/${target.id}/readers${query}`,'GET',undefined,AbortSignal.any([controller.signal,AbortSignal.timeout(8000)])));
      if(data.channel.id!==target.channel||data.message.id!==target.id||after&&data.readers.some(reader=>reader.id<=after))throw new Error('Message reader page did not match this selection');
      if(active.current&&!controller.signal.aborted){history.current=next;setPage({data,history:next});}
    }catch(e){if(active.current&&!controller.signal.aborted){failed.current=true;setPage(null);setError({message:e instanceof ApiError?e.message:'Message readers could not be loaded. Retry when connected.',history:next});}}
    finally{if(request.current===controller){request.current=null;if(active.current)setBusy(false);}}
  },[target.org,target.channel,target.id]);
  useEffect(()=>{active.current=true;void load([null]);const timer=setInterval(()=>{if(!request.current&&!failed.current)void load(history.current,true);},5000);return()=>{active.current=false;request.current?.abort();clearInterval(timer);};},[load]);
  return <Modal title="Message readers" onClose={onClose}><div className="modal-body message-readers">
    <p>People whose currently shared read position reaches your message. This does not confirm device delivery or when someone read it. Missing names do not prove unread. Each page checks current access and privacy.</p>
    <button className="secondary" disabled={busy} onClick={()=>void load([null])}>Refresh message readers</button>
    {busy&&<p role="status">Loading message readers…</p>}
    {error&&<div role="alert"><p>{error.message}</p><button className="secondary" disabled={busy} onClick={()=>void load(error.history)}>Retry message readers</button></div>}
    {page&&<><article aria-label="Reader source message"><h3>#{page.data.channel.name}</h3><p><time dateTime={page.data.message.created_at}>{new Date(page.data.message.created_at).toLocaleString()}</time></p>
      {Array.from(page.data.message.excerpt).length>120?<><p>{Array.from(page.data.message.excerpt).slice(0,120).join('')}…</p><details><summary>Full message excerpt</summary><p>{page.data.message.excerpt}</p></details></>:<p>{page.data.message.excerpt}</p>}
    </article>
      <nav aria-label="Message reader pages"><p role="status">Reader page {page.history.length} · {page.data.readers.length} shared {page.data.readers.length===1?'reader':'readers'}</p><div className="search-actions">
        <button className="secondary" disabled={busy||page.history.length===1} onClick={()=>void load(page.history.slice(0,-1))}>Previous readers</button>
        <button className="secondary" disabled={busy||!page.data.nextCursor} onClick={()=>{if(page.data.nextCursor)void load([...page.history,page.data.nextCursor]);}}>More readers</button>
      </div></nav>
      <ul aria-label="Shared message readers">{page.data.readers.map(reader=><li key={reader.id}>{reader.name}</li>)}</ul>
      {!page.data.readers.length&&<p>{page.history.length===1?'No shared readers returned for this message.':'No shared readers remain on this page. Refresh or use Previous readers.'}</p>}
    </>}
  </div></Modal>;
}
