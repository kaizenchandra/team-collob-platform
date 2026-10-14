"use client";
import {useEffect,useState} from 'react';
import {api} from '@/lib/contracts';
type Invitation={id:string;org_id:string;organization:string;role:string;expires_at:string};
export function InvitationInbox({onSave}:{onSave:()=>Promise<void>}){
  const [items,setItems]=useState<Invitation[]|null>(null),[error,setError]=useState(''),[actionError,setActionError]=useState(''),[attempt,setAttempt]=useState(0),[busy,setBusy]=useState(''),[done,setDone]=useState('');
  useEffect(()=>{
    let active=true,pending=false;
    const refresh=async()=>{if(pending)return;pending=true;try{const r=await api<{invitations:Invitation[]}>('/invitations');if(active){setItems(r.invitations);setError('');}}catch(e){if(active){setItems(null);setError(e instanceof Error?e.message:'Invitations unavailable');}}finally{pending=false;}};
    void refresh();const timer=setInterval(()=>void refresh(),5000);return()=>{active=false;clearInterval(timer);};
  },[attempt]);
  return <section className="card settings-form" aria-label="Workspace invitations">
    <h2>Workspace invitations</h2><p>Invitations addressed to your account email. Accepting grants the role shown below. Existing or inactive memberships must be managed by an administrator.</p>
    {error?<div role="alert"><p>{error}</p><button className="secondary" onClick={()=>setAttempt(n=>n+1)}>Retry invitations</button></div>:items===null?<p role="status">Loading invitations…</p>:!items.length?<p>No pending invitations.</p>:items.map(i=><div key={i.id} className="result-card">
      <strong>{i.organization}</strong><p>Role: {i.role} · Expires {new Date(i.expires_at).toLocaleString()}</p>
      <button className="secondary" disabled={!!busy} onClick={async()=>{setBusy(i.id);setDone('');setActionError('');try{await api('/invitations/accept','POST',{invitationId:i.id});setItems(current=>current?.filter(x=>x.id!==i.id)??null);setDone(`Joined ${i.organization}. Choose it from the workspace selector.`);await onSave();}catch(e){setActionError(e instanceof Error?e.message:'Invitation could not be accepted');}finally{setBusy('');setAttempt(n=>n+1);}}}>{busy===i.id?'Updating invitation…':`Accept invitation to ${i.organization}`}</button>
      <button className="secondary" disabled={!!busy} onClick={async()=>{setBusy(i.id);setDone('');setActionError('');try{await api(`/invitations/${i.id}`,'DELETE');setItems(current=>current?.filter(x=>x.id!==i.id)??null);setDone(`Declined invitation to ${i.organization}.`);}catch(e){setActionError(e instanceof Error?e.message:'Invitation could not be declined');}finally{setBusy('');setAttempt(n=>n+1);}}}>Decline invitation to {i.organization}</button>
    </div>)}
    {actionError&&<p role="alert">{actionError}</p>}
    {done&&<p role="status">{done}</p>}
  </section>;
}

export function InvitationNotice({onReview}:{onReview:()=>void}){
  const [count,setCount]=useState(0),[unavailable,setUnavailable]=useState(false);
  useEffect(()=>{
    let active=true,pending=false;const controller=new AbortController();
    const refresh=async()=>{if(pending)return;pending=true;try{const r=await api<{invitations:Invitation[]}>('/invitations','GET',undefined,AbortSignal.any([controller.signal,AbortSignal.timeout(8000)]));if(active){setCount(r.invitations.length);setUnavailable(false);}}catch{if(active){setCount(0);setUnavailable(true);}}finally{pending=false;}};
    void refresh();const timer=setInterval(()=>void refresh(),5000);return()=>{active=false;controller.abort();clearInterval(timer);};
  },[]);
  if(unavailable)return <div className="notice" role="status">Workspace invitations are temporarily unavailable. Retrying automatically.</div>;
  if(!count)return null;
  return <div className="notice"><span>Pending invitations across workspaces: {count===50?'50+':count}. </span><button className="secondary" onClick={onReview}>Review workspace invitations</button></div>;
}
