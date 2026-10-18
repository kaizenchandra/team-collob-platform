"use client";
/* Page snapshots reset on scope changes and are aborted before replacement. */
/* eslint-disable react-hooks/set-state-in-effect */
import {useCallback,useEffect,useRef,useState} from 'react';
import {z} from 'zod';
import {API,ApiError,api} from '@/lib/contracts';
import {Empty} from './primitives';
type Kind='messages'|'files';
type Open=(channel:string,kind:Kind,message?:string)=>void;
const base={id:z.uuid(),channel_id:z.uuid(),channel_name:z.string(),created_at:z.string()};
const cursor=z.object({createdAt:z.iso.datetime(),id:z.uuid()});
type Cursor=z.infer<typeof cursor>;
type Mode='navigate'|'refresh'|'current'|'poll';
const boundary={hasMore:z.boolean(),nextCursor:cursor.nullable()};
const response=z.discriminatedUnion('type',[
  z.object({type:z.literal('messages'),...boundary,results:z.array(z.object({...base,body:z.string(),author:z.string()})).max(50)}),
  z.object({type:z.literal('files'),...boundary,results:z.array(z.object({...base,name:z.string(),mime:z.string(),bytes:z.string(),state:z.string()})).max(50)}),
]).refine(value=>value.hasMore===(value.nextCursor!==null),'Invalid search page boundary');
function SearchRows({org,query,kind,channelId,onOpen}:{org:string;query:string;kind:Kind;channelId:string;onOpen:Open}){
  const [page,setPage]=useState<{data:z.infer<typeof response>;history:(Cursor|null)[]}|null>(null),[busy,setBusy]=useState(false);
  const [error,setError]=useState<{message:string;history:(Cursor|null)[];mode:Mode}|null>(null);
  const active=useRef(true),request=useRef<AbortController|null>(null),history=useRef<(Cursor|null)[]>([null]);
  const load=useCallback(async(nextHistory:(Cursor|null)[]=history.current,mode:Mode='current')=>{
    request.current?.abort();const controller=new AbortController();request.current=controller;
    if(mode!=='poll'){setBusy(true);setError(null);}
    if(mode==='refresh'){history.current=[null];setPage(null);}
    const before=nextHistory.at(-1),parameters=new URLSearchParams({q:query,type:kind,...(channelId?{channelId}:{}),...(before?{beforeCreated:before.createdAt,beforeId:before.id}:{})});
    try{
      const result=response.parse(await api(`/organizations/${org}/search?${parameters}`,'GET',undefined,AbortSignal.any([controller.signal,AbortSignal.timeout(8000)])));
      if(result.type!==kind)throw new Error('Search response did not match the requested type');
      if(active.current&&!controller.signal.aborted){history.current=nextHistory;setPage({data:result,history:nextHistory});setError(previous=>mode==='poll'&&previous?.mode==='navigate'?previous:null);}
    }catch(e){
      if(active.current&&!controller.signal.aborted){
        if(mode!=='navigate'||e instanceof ApiError&&[401,403,404].includes(e.status))setPage(null);
        setError({message:e instanceof Error?e.message:'Search unavailable',history:nextHistory,mode});
      }
    }finally{if(active.current&&request.current===controller){request.current=null;setBusy(false);}}
  },[org,query,kind,channelId]);
  useEffect(()=>{
    active.current=true;void load([null],'refresh');const timer=setInterval(()=>{if(!request.current)void load(history.current,'poll');},5000);
    return()=>{active.current=false;request.current?.abort();clearInterval(timer);};
  },[load]);
  const data=page?.data;
  const noun=data?.type==='files'?'file':'message';
  return <>
    <p>Browse up to 50 matches per page, newest first. The list can change while you browse.</p>
    <button className="secondary" disabled={busy} onClick={()=>void load([null],'refresh')}>Refresh matches</button>
    {busy&&<p role="status">Searching…</p>}
    {error&&<div role="alert"><p>{error.message}</p><button className="secondary" disabled={busy} onClick={()=>void load(error.history,error.mode==='poll'?'current':error.mode)}>Retry search</button></div>}
    {data&&<p role="status">{data.results.length} matching {noun}{data.results.length===1?'':'s'} for “{query}”.</p>}
    {page&&<nav aria-label="Search pages"><p role="status">Search page {page.history.length} · {page.data.results.length} {page.data.results.length===1?'result':'results'}</p>
      <div className="search-actions"><button className="secondary" disabled={busy||page.history.length===1} onClick={()=>void load(page.history.slice(0,-1),'navigate')}>Newer matches</button>
      <button className="secondary" disabled={busy||!page.data.nextCursor} onClick={()=>{if(page.data.nextCursor)void load([...page.history,page.data.nextCursor],'navigate');}}>Older matches</button></div>
    </nav>}
    {data?.hasMore&&<p role="status">More matches are available on older pages.</p>}
    {page&&page.data.results.length===0&&(page.history.length>1?<p>No matches remain on this page. Refresh or use the page controls to continue.</p>:<Empty title={`No matching ${kind}`}>Try a different word, filename or conversation.</Empty>)}
    {data?.type==='messages'&&data.results.map(result=><button className="result-card" disabled={busy} key={result.id} onClick={()=>onOpen(result.channel_id,'messages',result.id)}><strong>#{result.channel_name} <small>{result.author}</small></strong><p>{result.body}</p></button>)}
    {data?.type==='files'&&data.results.map(file=><article className="result-card" aria-label={`${file.name} in ${file.channel_name}`} key={file.id}>
      <h2>{file.name}</h2><p>#{file.channel_name} · {Math.ceil(Number(file.bytes)/1024)} KB · {file.state}</p>
      <div className="search-actions"><button className="secondary" disabled={busy} onClick={()=>onOpen(file.channel_id,'files',file.id)}>View file</button><button className="secondary" disabled={busy} onClick={()=>onOpen(file.channel_id,'files')}>Open files in #{file.channel_name}</button>
        {file.state==='ready'&&<a className="secondary" aria-label={`Download ${file.name}`} href={`${API}/v1/channels/${file.channel_id}/files/${file.id}/download`}>Download</a>}
      </div>
    </article>)}
  </>;
}
export function WorkspaceSearch({org,orgName,query,channels,onClose,onOpen}:{org:string;orgName:string;query:string;channels:{id:string;name:string}[];onClose:()=>void;onOpen:Open}){
  const [kind,setKind]=useState<Kind>('messages'),[channelId,setChannelId]=useState('');
  return <section className="workspace-search" aria-label="Workspace search results">
    <div className="page-heading"><div><span className="eyebrow">{orgName}</span><h1>Search results</h1><p>Search messages or original filenames you currently have permission to view. File contents and version filenames are not searched.</p></div><button className="secondary" onClick={onClose}>Back to conversation</button></div>
    <div className="content-pad"><div className="search-filters">
      <label>Search type<select aria-label="Search type" value={kind} onChange={e=>setKind(e.target.value as Kind)}><option value="messages">Messages</option><option value="files">Files</option></select></label>
      <label>Search conversation<select aria-label="Search conversation" value={channelId} onChange={e=>setChannelId(e.target.value)}><option value="">All conversations</option>{channels.map(channel=><option value={channel.id} key={channel.id}>{channel.name}</option>)}</select></label>
    </div><SearchRows key={`${kind}:${channelId}`} org={org} query={query} kind={kind} channelId={channelId} onOpen={onOpen}/></div>
  </section>;
}
