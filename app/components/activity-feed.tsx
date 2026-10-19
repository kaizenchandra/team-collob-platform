"use client";
import {useCallback,useEffect,useId,useRef,useState} from 'react';
import {z} from 'zod';
import {Bell} from 'lucide-react';
import {ApiError,api} from '@/lib/contracts';
import {MessageContent} from './message-content';
import {Empty} from './primitives';
const filterSchema=z.enum(['unread','mentions','replies']);
type Filter=z.infer<typeof filterSchema>;
const cursor=z.object({createdAt:z.iso.datetime(),id:z.uuid()});
type Cursor=z.infer<typeof cursor>;
type Mode='navigate'|'refresh'|'current'|'poll';
const snapshot=z.object({items:z.array(z.object({id:z.uuid(),channel_id:z.uuid(),channel_name:z.string(),author:z.string(),body:z.string(),format:z.enum(['plain','markdown-v1']),mentions:z.array(z.object({id:z.uuid(),name:z.string()})),mentioned:z.boolean(),replied:z.boolean(),created_at:z.iso.datetime()})).max(50),hasMore:z.boolean(),nextCursor:cursor.nullable()}).refine(v=>v.hasMore===(v.nextCursor!==null),'Invalid activity page boundary');
export function ActivityFeed({org,filter,onFilter,onOpen,onConversation,onCancel}:{org:string;filter:Filter;onFilter:(filter:Filter)=>void;onOpen:(channel:string,id:string)=>void;onConversation:(channel:string)=>Promise<boolean>;onCancel:()=>void}) {
  const [data,setData]=useState<{filter:Filter;page:z.infer<typeof snapshot>;history:(Cursor|null)[]}|null>(null),[failure,setFailure]=useState<{filter:Filter;message:string;history:(Cursor|null)[];mode:Mode}|null>(null),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[navigationError,setNavigationError]=useState('');
  const filterId=useId(),mounted=useRef(true),request=useRef<AbortController|null>(null),navigating=useRef(false),history=useRef<(Cursor|null)[]>([null]);
  const current=data?.filter===filter?data:null,items=current?.page.items??null,error=failure?.filter===filter?failure:null;
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;request.current?.abort();if(navigating.current)onCancel();};},[onCancel]);
  const load=useCallback(async(nextHistory:(Cursor|null)[]=history.current,mode:Mode='current')=>{
    request.current?.abort();const controller=new AbortController();request.current=controller;
    if(mode!=='poll'){setLoading(true);setFailure(null);}
    if(mode==='refresh'){history.current=[null];setData(null);}
    const before=nextHistory.at(-1),query=new URLSearchParams({filter,...(before?{beforeCreated:before.createdAt,beforeId:before.id}:{})});
    try {
      const result=snapshot.parse(await api(`/organizations/${org}/activity?${query}`,'GET',undefined,AbortSignal.any([controller.signal,AbortSignal.timeout(8000)])));
      if(mounted.current&&!controller.signal.aborted){history.current=nextHistory;setData({filter,page:result,history:nextHistory});setFailure(previous=>mode==='poll'&&previous?.mode==='navigate'?previous:null);}
    } catch(e) {if(mounted.current&&!controller.signal.aborted){if(mode!=='navigate'||e instanceof ApiError&&[401,403,404].includes(e.status))setData(null);setFailure({filter,message:e instanceof Error?e.message:'Activity unavailable',history:nextHistory,mode});}}
    finally {if(request.current===controller){request.current=null;if(mounted.current)setLoading(false);}}
  },[org,filter]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- Hydrate the scoped remote activity selection.
  useEffect(()=>{void load([null],'refresh');const timer=setInterval(()=>{if(!request.current&&!navigating.current)void load(history.current,'poll');},5000);return()=>{clearInterval(timer);request.current?.abort();};},[load]);
  const disabled=busy||loading;
  return <><div className="page-heading"><div><span className="eyebrow">STAY IN THE LOOP</span><h1>Your activity</h1><p>Catch up on unread messages, mentions and replies.</p>
    <label htmlFor={filterId}>Activity filter</label><select id={filterId} aria-label="Activity filter" value={filter} disabled={busy} onChange={e=>{setNavigationError('');onFilter(filterSchema.parse(e.target.value));}}><option value="unread">Unread messages</option><option value="mentions">Mentions of me</option><option value="replies">Replies to me</option></select>
  </div><Bell size={28}/></div>
    <section className="content-pad activity-feed" aria-label="Activity messages"><p>Up to 50 matching messages per page, newest first. Results can change while you browse.</p><button className="secondary" disabled={busy} onClick={()=>void load([null],'refresh')}>Refresh activity</button>
      {(loading||(!items&&!error))&&<p role="status">Loading activity…</p>}
      {error&&<div role="alert"><p>{error.message}</p><button className="secondary" disabled={disabled} onClick={()=>void load(error.history,error.mode==='poll'?'current':error.mode)}>Retry activity</button></div>}{navigationError&&<p role="alert">{navigationError}</p>}
      {current&&<nav aria-label="Activity pages"><p role="status">Activity page {current.history.length} · {current.page.items.length} {current.page.items.length===1?'message':'messages'}</p><div className="search-actions">
        <button className="secondary" disabled={disabled||current.history.length===1} onClick={()=>void load(current.history.slice(0,-1),'navigate')}>Newer activity</button>
        <button className="secondary" disabled={disabled||!current.page.nextCursor} onClick={()=>{if(current.page.nextCursor)void load([...current.history,current.page.nextCursor],'navigate');}}>Older activity</button>
      </div></nav>}
      {items&&(items.length?items.map(a=><article className="result-card" key={a.id} aria-label={`Activity message by ${a.author}`}><strong>{a.author} <small>in #{a.channel_name}</small></strong>
        <p><time dateTime={a.created_at}>{new Date(a.created_at).toLocaleString()}</time></p>
        {a.mentioned&&<span className="mention">Mentioned you</span>}{a.replied&&<span className="mention">Replied to you</span>}
        <MessageContent body={a.body} format={a.format} mentions={a.mentions}/>
        <div className="search-actions"><button className="secondary" disabled={busy} onClick={()=>onOpen(a.channel_id,a.id)}>View message</button>
          <button className="secondary" disabled={busy} onClick={async()=>{if(navigating.current)return;navigating.current=true;setBusy(true);setNavigationError('');try{const opened=await onConversation(a.channel_id);if(mounted.current&&!opened)setNavigationError('Conversation could not be opened. Your draft was kept.');}catch{if(mounted.current)setNavigationError('Conversation could not be opened. Your draft was kept.');}finally{navigating.current=false;if(mounted.current)setBusy(false);}}}>Open conversation</button></div>
      </article>):!loading&&!error&&(current&&current.history.length>1?<p>No matching messages remain on this page. Refresh or use the page controls to continue.</p>:<Empty title={filter==='unread'?'You’re all caught up':filter==='mentions'?'No mentions found':'No replies found'}>New matching messages in accessible conversations will appear here.</Empty>))}
    </section></>;
}
