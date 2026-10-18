"use client";
import {useState,useRef,useEffect,useCallback,useId} from 'react';
import {z} from 'zod';
import {api} from '@/lib/contracts';
const snapshot=z.object({teamId:z.uuid(),name:z.string(),archived:z.boolean(),can_transfer:z.boolean(),can_recover:z.boolean(),recoveryToken:z.string().regex(/^[a-f0-9]{64}$/),owners:z.array(z.object({id:z.uuid(),name:z.string(),active:z.boolean()})).max(1000),candidates:z.array(z.object({id:z.uuid(),name:z.string()})).max(1000)});
type Ownership=z.infer<typeof snapshot>;
export function TeamOwnership({org,team,onChanged}:{org:string;team:string;onChanged:()=>Promise<void>}){
  const [data,setData]=useState<Ownership|null>(null),[target,setTarget]=useState(''),[confirm,setConfirm]=useState(false),[recover,setRecover]=useState(false),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const request=useRef<AbortController|null>(null),mounted=useRef(true),selectId=useId();
  const load=useCallback(async()=>{
    request.current?.abort();const controller=new AbortController();request.current=controller;setLoading(true);setData(null);setError('');setConfirm(false);setRecover(false);setTarget('');setNotice('');
    try{const result=snapshot.parse(await api(`/organizations/${org}/teams/${team}/ownership`,'GET',undefined,AbortSignal.any([controller.signal,AbortSignal.timeout(12000)])));if(result.teamId!==team)throw new Error('Team scope could not be verified');if(!controller.signal.aborted)setData(result);}
    catch(e){if(!controller.signal.aborted)setError(e instanceof Error?e.message:'Ownership unavailable');}
    finally{if(request.current===controller){request.current=null;setLoading(false);}}
  },[org,team]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- Load the mounted team-scoped ownership snapshot.
  useEffect(()=>{mounted.current=true;void load();return()=>{mounted.current=false;request.current?.abort();};},[load]);
  return <section aria-label="Team ownership"><h3>Team ownership</h3><button className="secondary" disabled={loading||busy} onClick={()=>void load()}>Refresh ownership</button>
    {loading&&<p role="status">Loading ownership…</p>}{error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
    {data&&<><ul>{data.owners.map(owner=><li key={owner.id}>{owner.name}{!owner.active?' (inactive)':''}</li>)}</ul>
      <p>The last active owner must transfer ownership before leaving. Ownership does not grant workspace administrator privileges or new channel access.</p>
      {data.can_transfer?<><label htmlFor={selectId}>New team owner</label><select id={selectId} value={target} disabled={busy} onChange={e=>{setTarget(e.target.value);setConfirm(false);}}><option value="">Choose an eligible team member</option>{data.candidates.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select>
        {!confirm?<button className="secondary" disabled={busy||!target} onClick={()=>setConfirm(true)}>Transfer team ownership</button>:<div><p>Transfer your ownership to {data.candidates.find(p=>p.id===target)?.name}? You will remain a team member and can leave afterward. You will lose owner controls.</p><button className="secondary" disabled={busy} onClick={async()=>{setBusy(true);setError('');try{await api(`/organizations/${org}/teams/${team}/transfer-ownership`,'POST',{userId:target,expectedOwners:data.owners.map(p=>p.id)});if(mounted.current){await load();await onChanged();if(mounted.current)setNotice('Team ownership transferred.');}}catch(e){if(mounted.current)setError(e instanceof Error?e.message:'Transfer could not be confirmed. Refresh ownership before retrying.');}finally{if(mounted.current)setBusy(false);}}}>Confirm ownership transfer</button><button className="secondary" disabled={busy} onClick={()=>setConfirm(false)}>Keep ownership</button></div>}
        {!data.candidates.length&&<p>No eligible existing team member is available. A successor must be active, enabled and not a guest or current owner.</p>}
      </>:<p>{data.archived?'Restore the team before transferring ownership.':'Only current team owners can transfer their ownership.'}</p>}
      {data.can_recover&&<><h4>Recover team ownership</h4><p>No active owner remains. A workspace owner in this team can appoint an existing member. Inactive former owners become ordinary members, even if their accounts are later reactivated.</p>
        <label htmlFor={`${selectId}-recovery`}>Recovery owner</label><select id={`${selectId}-recovery`} value={target} disabled={busy} onChange={e=>{setTarget(e.target.value);setRecover(false);}}><option value="">Choose an eligible team member</option>{data.candidates.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select>
        {!recover?<button className="secondary" disabled={busy||!target} onClick={()=>setRecover(true)}>Review ownership recovery</button>:<div><p>Appoint {data.candidates.find(p=>p.id===target)?.name} and reset inactive owners to members? Workspace roles and channel access stay the same.</p><button className="secondary" disabled={busy} onClick={async()=>{setBusy(true);setError('');try{await api(`/organizations/${org}/teams/${team}/recover-ownership`,'POST',{userId:target,expectedRecovery:data.recoveryToken,confirm:true});if(mounted.current){await load();await onChanged();if(mounted.current)setNotice('Team ownership recovered.');}}catch(e){if(mounted.current)setError(e instanceof Error?e.message:'Recovery could not be confirmed. Refresh ownership before retrying.');}finally{if(mounted.current)setBusy(false);}}}>Confirm ownership recovery</button><button className="secondary" disabled={busy} onClick={()=>setRecover(false)}>Cancel recovery</button></div>}
      </>}

    </>}
  </section>;
}
