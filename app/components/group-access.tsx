"use client";
import {useId,useRef,useEffect,useState} from 'react';
import {api,type Person} from '@/lib/contracts';
type Participant={id:string;name:string};
export function GroupAccess({id,revision,participants,people,userId,onChanged,disabled,scope='group'}:{scope?:'group'|'channel';id:string;revision:number;participants:Participant[];people:Person[];userId:string;onChanged:()=>Promise<void>;disabled:boolean}){
  const selectId=useId();const [target,setTarget]=useState(''),[grant,setGrant]=useState(false),[remove,setRemove]=useState<Participant|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const mounted=useRef(true);useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  async function change(method:'PUT'|'DELETE',user:string){
    setBusy(true);setError('');
    try{await api(`/channels/${id}/${scope==='group'?'group-members':'explicit-members'}/${user}`,method,method==='PUT'?{revision,history:'all-retained'}:{revision});if(mounted.current)await onChanged();}
    catch(e){if(mounted.current)setError(e instanceof Error?e.message:'Participant change could not be confirmed. Refresh participants before retrying.');}
    finally{if(mounted.current)setBusy(false);}
  }
  const candidates=people.filter(p=>!participants.some(m=>m.id===p.id));
  return <section aria-label={`Manage ${scope} access`}><h3>Manage {scope} access</h3>
    <p>Workspace owners and admins who belong to this {scope} can add or remove {scope==='group'?'participants':'members'}. Refresh {scope==='group'?'participants':'channel access'} after a conflict or an uncertain response.</p>
    {error&&<p role="alert">{error}</p>}
    <form onSubmit={e=>{e.preventDefault();if(grant&&target)void change('PUT',target);}}>
      <label htmlFor={selectId}>{scope==='group'?'Add group participant':'Add channel member'}</label><select id={selectId} value={target} disabled={busy||disabled} onChange={e=>{setTarget(e.target.value);setGrant(false);}}><option value="">Choose a workspace member</option>{candidates.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select>
      <label className="check-label"><input type="checkbox" style={{flexShrink:0,width:16,height:16}} checked={grant} disabled={busy||disabled||!target} onChange={e=>setGrant(e.target.checked)}/>Grant access to all retained messages and files, including history from before joining.</label>
      <button className="secondary" disabled={busy||disabled||!target||!grant}>{scope==='group'?'Add participant with history':'Add member with history'}</button>
    </form>
    {participants.filter(p=>p.id!==userId).map(p=><button key={p.id} className="secondary" disabled={busy||disabled} onClick={()=>{setRemove(p);setError('');}}>Remove {p.name} from {scope}</button>)}
    {remove&&<div><p>Remove {remove.name}? They will lose access and their personal draft. Their existing messages remain. Previously downloaded content cannot be recalled.</p><button className="secondary" disabled={busy||disabled} onClick={()=>void change('DELETE',remove.id)}>{scope==='group'?'Confirm remove participant':'Confirm remove member'}</button><button className="secondary" disabled={busy} onClick={()=>setRemove(null)}>{scope==='group'?'Keep participant':'Keep member'}</button></div>}
  </section>;
}
