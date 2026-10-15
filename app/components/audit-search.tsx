"use client";
import {useCallback,useEffect,useId,useRef,useState} from 'react';
import {api,API,type Person} from '@/lib/contracts';
type Filters={action:string;actor:string;target:string;from:string;to:string};
type AuditEvent={id:string;action:string;actor:string|null;actor_id:string|null;target:string;created_at:string;metadata:unknown};
const empty:Filters={action:'',actor:'',target:'',from:'',to:''};
function preparedFilters(draft:Filters):Filters{
  if(!!draft.from!==!!draft.to)throw new Error('Provide both audit time bounds.');
  const filters={...draft,action:draft.action.trim(),actor:draft.actor.trim(),target:draft.target.trim(),from:draft.from?new Date(draft.from).toISOString():'',to:draft.to?new Date(draft.to).toISOString():''};
  if(filters.from&&Date.parse(filters.to)<=Date.parse(filters.from))throw new Error('Audit end must be after its start.');return filters;
}

export function AuditSearch({org,people}:{org:string;people:Person[]}){
  const actorsId=useId(),[draft,setDraft]=useState<Filters>(empty),[applied,setApplied]=useState<Filters>(empty),[rows,setRows]=useState<AuditEvent[]>([]),[cursor,setCursor]=useState<string|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState(''),[formError,setFormError]=useState('');
  const request=useRef<AbortController|null>(null),exportRequest=useRef<AbortController|null>(null);
  const [exporting,setExporting]=useState(false),[exportError,setExportError]=useState(''),[exportStatus,setExportStatus]=useState('');
  useEffect(()=>()=>exportRequest.current?.abort(),[org,applied]);
  const load=useCallback(async(after?:string)=>{
    request.current?.abort();const controller=new AbortController();request.current=controller;setLoading(true);setError('');if(!after){setRows([]);setCursor(null);}
    const q=new URLSearchParams({limit:'20'});for(const [key,value] of Object.entries(applied))if(value)q.set(key,value);if(after)q.set('beforeId',after);
    try{const r=await api<{items:AuditEvent[];nextCursor:string|null}>(`/organizations/${org}/audit?${q}`,'GET',undefined,AbortSignal.any([controller.signal,AbortSignal.timeout(8000)]));if(!controller.signal.aborted){setRows(old=>after?[...old,...r.items.filter(i=>!old.some(x=>x.id===i.id))]:r.items);setCursor(r.nextCursor);}}
    catch(e){if(!controller.signal.aborted)setError(e instanceof Error?e.message:'Audit search unavailable');}
    finally{if(request.current===controller){request.current=null;setLoading(false);}}
  },[org,applied]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- Reset remote results before loading the newly applied scope.
  useEffect(()=>{void load();return()=>request.current?.abort();},[load]);
  const download=async()=>{
    const controller=new AbortController();exportRequest.current=controller;setExporting(true);setExportError('');setExportStatus('');
    try{
      const q=new URLSearchParams();for(const [key,value] of Object.entries(applied))if(value)q.set(key,value);
      const response=await fetch(`${API}/v1/organizations/${org}/audit/export?${q}`,{credentials:'include',cache:'no-store',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15000)])});
      if(!response.ok){const data=await response.json();throw new Error(data.error??'Audit export unavailable');}
      const blob=await response.blob();if(controller.signal.aborted)return;if(blob.size>2*1024*1024)throw new Error('Audit export exceeds the download limit. Narrow the filters.');
      const data=JSON.parse(await blob.text());if(data.format!=='concord.audit.v1'||data.organizationId!==org||!Array.isArray(data.items)||data.count!==data.items.length||data.count>1000||!data.items.every((i:{id?:unknown;org_id?:unknown})=>i&&typeof i.id==='string'&&i.org_id===org))throw new Error('Audit export scope or format could not be verified.');
      const expected=response.headers.get('X-Export-SHA256');if(!expected||!crypto.subtle)throw new Error('Audit export verification requires a secure browser context.');
      const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer())),v=>v.toString(16).padStart(2,'0')).join('');if(digest!==expected)throw new Error('Audit export integrity check failed. Retry the export.');if(controller.signal.aborted)return;
      const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=`concord-audit-${org}.json`;document.body.appendChild(link);try{link.click();}finally{link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}setExportStatus(`Verified audit export prepared with ${data.count} events. Your browser controls saving.`);
    }catch(e){if(!controller.signal.aborted)setExportError(e instanceof Error?e.message:'Audit export failed');}finally{if(exportRequest.current===controller){exportRequest.current=null;setExporting(false);}}
  };
  let dirty=true;try{dirty=JSON.stringify(preparedFilters(draft))!==JSON.stringify(applied);}catch{}
  const update=(key:keyof Filters,value:string)=>setDraft(old=>({...old,[key]:value}));
  return <section aria-label="Audit search"><h2>Audit history</h2><p>Exact action, actor and target filters. Times below use {Intl.DateTimeFormat().resolvedOptions().timeZone}; both bounds are required for a time range, with an exclusive end and a maximum of 366 days.</p>
    <form onSubmit={e=>{e.preventDefault();setFormError('');try{setApplied(preparedFilters(draft));setExportError('');setExportStatus('');}catch(e){setFormError(e instanceof Error?e.message:'Check audit filters');}}}>
      <label>Audit action<input value={draft.action} maxLength={120} placeholder="message.deleted" onChange={e=>update('action',e.target.value)}/></label>
      <label>Audit actor id<input value={draft.actor} maxLength={36} list={actorsId} onChange={e=>update('actor',e.target.value)}/></label><datalist id={actorsId}>{people.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</datalist>
      <label>Audit target<input value={draft.target} maxLength={500} onChange={e=>update('target',e.target.value)}/></label>
      <label>Audit from<input type="datetime-local" step="1" value={draft.from} onChange={e=>update('from',e.target.value)}/></label><label>Audit before<input type="datetime-local" step="1" value={draft.to} onChange={e=>update('to',e.target.value)}/></label>
      <button className="primary" disabled={loading||exporting}>Search audit</button><button type="button" className="secondary" disabled={loading||exporting} onClick={()=>{setDraft(empty);setApplied({...empty});setFormError('');setExportError('');setExportStatus('');}}>Clear audit filters</button>
    </form>
    <p>Export uses the applied search filters across all matching events, up to 1,000 events and 2 MiB. Apply edited filters before exporting; larger exports must be narrowed.</p><button className="secondary" disabled={loading||exporting||!!error||dirty} onClick={()=>void download()}>{exporting?'Preparing audit export…':'Download audit JSON'}</button>{exportError&&<p role="alert">{exportError}</p>}{exportStatus&&<p role="status">{exportStatus}</p>}
    {formError&&<p role="alert">{formError}</p>}{error&&<><p role="alert">{error}</p><button className="secondary" disabled={loading||exporting} onClick={()=>void load(cursor&&rows.length?cursor:undefined)}>Retry audit search</button></>}{loading&&<p role="status">Loading audit events…</p>}{!loading&&!error&&!rows.length&&<p>No audit events match these filters.</p>}
    {rows.map(a=><article className="result-card" key={a.id}><h3>{a.action}</h3><p>{a.actor??'System'} · <time dateTime={a.created_at}>{new Date(a.created_at).toLocaleString()}</time></p><p>Actor id: {a.actor_id??'System'}</p><p style={{overflowWrap:'anywhere'}}>Target: {a.target}</p><p>Event id: {a.id}</p><details><summary>Event metadata</summary><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{JSON.stringify(a.metadata,null,2)}</pre></details></article>)}
    {cursor&&<button className="secondary" disabled={loading||exporting} onClick={()=>void load(cursor)}>Load more audit events</button>}
  </section>;
}
