"use client";
/* Remote pages are scoped and replaced only after validation. */
/* eslint-disable react-hooks/set-state-in-effect */
import {useCallback,useEffect,useRef,useState} from 'react';
import {z} from 'zod';
import {api,ApiError} from '@/lib/contracts';
import type {MessageLinkTarget} from '@/lib/message-link';
const cursor=z.object({createdAt:z.iso.datetime(),id:z.uuid()});
const snapshot=z.object({channel:z.object({id:z.uuid(),name:z.string()}),parentId:z.uuid(),replies:z.array(z.object({id:z.uuid(),author:z.string(),created_at:z.iso.datetime({offset:true}),excerpt:z.string()})).max(50),hasMore:z.boolean(),nextCursor:cursor.nullable()}).refine(page=>page.hasMore===(page.nextCursor!==null)&&(!page.hasMore||page.replies.length===50&&page.nextCursor?.id===page.replies.at(-1)?.id)&&new Set(page.replies.map(reply=>reply.id)).size===page.replies.length,'Invalid reply page');
type Cursor=z.infer<typeof cursor>;
export function DirectReplies({target,onOpen,disabled=false}:{target:MessageLinkTarget;onOpen:(id:string)=>void;disabled?:boolean}){
  const [page,setPage]=useState<{data:z.infer<typeof snapshot>;history:(Cursor|null)[]}|null>(null),[busy,setBusy]=useState(true),[error,setError]=useState<{message:string;history:(Cursor|null)[]}|null>(null);
  const active=useRef(true),request=useRef<AbortController|null>(null),history=useRef<(Cursor|null)[]>([null]),failed=useRef(false);
  const load=useCallback(async(next:(Cursor|null)[]=history.current)=>{
    request.current?.abort();const controller=new AbortController();request.current=controller;setBusy(true);setError(null);failed.current=false;
    const before=next.at(-1),query=before?'?'+new URLSearchParams({beforeCreated:before.createdAt,beforeId:before.id}):'';
    try{
      const data=snapshot.parse(await api(`/organizations/${target.org}/channels/${target.channel}/messages/${target.id}/replies${query}`,'GET',undefined,AbortSignal.any([controller.signal,AbortSignal.timeout(8000)])));
      if(data.channel.id!==target.channel||data.parentId!==target.id)throw new Error('Reply page did not match this message');
      if(active.current&&!controller.signal.aborted){history.current=next;setPage({data,history:next});}
    }catch(e){if(active.current&&!controller.signal.aborted){failed.current=true;setPage(null);setError({message:e instanceof ApiError?e.message:'Direct replies could not be loaded. Retry when connected.',history:next});}}
    finally{if(request.current===controller){request.current=null;if(active.current)setBusy(false);}}
  },[target.org,target.channel,target.id]);
  useEffect(()=>{
    active.current=true;void load([null]);const timer=setInterval(()=>{if(!request.current&&!failed.current)void load();},5000);
    return()=>{active.current=false;request.current?.abort();clearInterval(timer);};
  },[load]);
  return <section className="reply-context direct-replies" aria-label="Direct replies"><h4>Direct replies</h4>
    <p>Newest first, up to 50 per page. Excerpts are plain text; open a reply for its current full source. Nested replies are shown from their own source.</p>
    <button className="secondary" disabled={busy} onClick={()=>void load([null])}>Refresh direct replies</button>
    {busy&&<p role="status">Loading direct replies…</p>}
    {error&&<div role="alert"><p>{error.message}</p><button className="secondary" disabled={busy} onClick={()=>void load(error.history)}>Retry direct replies</button></div>}
    {page&&<><nav aria-label="Direct reply pages"><p role="status">Reply page {page.history.length} · {page.data.replies.length} {page.data.replies.length===1?'reply':'replies'}</p>
      <div className="search-actions"><button className="secondary" disabled={busy||page.history.length===1} onClick={()=>void load(page.history.slice(0,-1))}>Newer replies</button><button className="secondary" disabled={busy||!page.data.nextCursor} onClick={()=>{if(page.data.nextCursor)void load([...page.history,page.data.nextCursor]);}}>Older replies</button></div></nav>
      {page.data.replies.map(reply=><article key={reply.id} aria-label="Direct reply"><h4>{reply.author}</h4><p><time dateTime={reply.created_at}>{new Date(reply.created_at).toLocaleString()}</time></p><p>{reply.excerpt}</p><button className="secondary" disabled={busy||disabled} onClick={()=>onOpen(reply.id)}>Open reply source</button></article>)}
      {!page.data.replies.length&&<p>{page.history.length===1?'No direct replies.':'No direct replies remain on this page. Refresh or use Newer replies.'}</p>}
    </>}
  </section>;
}
