"use client";
import {useCallback,useEffect,useRef,useState,useId} from 'react';
import {z} from 'zod';
import {api,type Person} from '@/lib/contracts';
const snapshot=z.object({teamId:z.uuid(),name:z.string(),archived:z.boolean(),membershipToken:z.string().regex(/^[a-f0-9]{64}$/),members:z.array(z.object({id:z.uuid(),name:z.string(),role:z.enum(['owner','member']),active:z.boolean()})).max(1000)});
type Roster=z.infer<typeof snapshot>;
export function TeamMembers({org,team,people,userId,onChanged}:{org:string;team:string;people:Person[];userId:string;onChanged:()=>Promise<void>}){
  const [data,setData]=useState<Roster|null>(null),[target,setTarget]=useState(''),[grant,setGrant]=useState(false),[remove,setRemove]=useState<{id:string;name:string}|null>(null),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState('');const request=useRef<AbortController|null>(null),mounted=useRef(true),selectId=useId();
  const load=useCallback(async()=>{
    request.current?.abort();const controller=new AbortController();request.current=controller;setData(null);setError('');setLoading(true);setTarget('');setGrant(false);setRemove(null);
    try{const result=snapshot.parse(await api(`/organizations/${org}/teams/${team}/members`,'GET',undefined,AbortSignal.any([controller.signal,AbortSignal.timeout(12000)])));if(result.teamId!==team)throw new Error('Team member scope could not be verified');if(!controller.signal.aborted)setData(result);}
    catch(e){if(!controller.signal.aborted)setError(e instanceof Error?e.message:'Team members unavailable');}
    finally{if(request.current===controller){request.current=null;setLoading(false);}}
  },[org,team]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- Load the team-scoped authoritative roster.
  useEffect(()=>{mounted.current=true;void load();return()=>{mounted.current=false;request.current?.abort();};},[load]);
  async function change(method:'PUT'|'DELETE',id:string){
    if(!data)return;setBusy(true);setError('');
    try{await api(`/organizations/${org}/teams/${team}/members/${id}`,method,{expectedMembership:data.membershipToken,...(method==='PUT'?{history:'all-retained-standard'}:{})});if(mounted.current){await load();await onChanged();}}
    catch(e){if(mounted.current)setError(e instanceof Error?e.message:'Change could not be confirmed. Refresh team members before retrying.');}
    finally{if(mounted.current)setBusy(false);}
  }
  return <section aria-label="Team members"><h3>Team members</h3><p>Workspace admins who belong to this team can admit or remove members. Team ownership and workspace roles are separate.</p><button className="secondary" disabled={loading||busy} onClick={()=>void load()}>Refresh team members</button>
    {loading&&<p role="status">Loading team members…</p>}{error&&<p role="alert">{error}</p>}
    {data&&<><ul>{[...data.members].sort((a,b)=>a.name.localeCompare(b.name)).map(p=><li key={p.id}>{p.name}{p.role==='owner'?' (owner)':''}{p.active?'':' (inactive)'}</li>)}</ul>
      {data.archived&&<p>Restore the team before changing membership.</p>}
      <form onSubmit={e=>{e.preventDefault();if(target&&grant)void change('PUT',target);}}>
        <label htmlFor={selectId}>Add team member</label><select id={selectId} value={target} disabled={busy||data.archived} onChange={e=>{setTarget(e.target.value);setGrant(false);}}><option value="">Choose a workspace member</option>{people.filter(p=>!data.members.some(m=>m.id===p.id)).map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select>
        <label className="check-label"><input type="checkbox" style={{flexShrink:0,width:16,height:16}} checked={grant} disabled={busy||data.archived||!target} onChange={e=>setGrant(e.target.checked)}/>Grant access to all retained history and files in this team&apos;s standard channels.</label>
        <p>Private and shared channels require separate explicit grants. Members may still self-join open teams; removal is not a membership ban.</p><button className="secondary" disabled={busy||data.archived||!target||!grant}>Add member with standard history</button>
      </form>
      <p>Transfer ownership before removing an owner. Use Leave team for your own membership.</p>
      {data.members.filter(p=>p.id!==userId&&p.role!=='owner').map(p=><button className="secondary" key={p.id} disabled={busy||data.archived} onClick={()=>{setRemove(p);setError('');}}>Remove {p.name} from team</button>)}
      {remove&&<div><p>Remove {remove.name}? This revokes standard-channel access and private-channel grants in this team, and clears their drafts/preferences there. Shared-channel grants and shared content remain.</p><button className="secondary" disabled={busy||data.archived} onClick={()=>void change('DELETE',remove.id)}>Confirm remove team member</button><button className="secondary" disabled={busy} onClick={()=>setRemove(null)}>Keep team member</button></div>}
    </>}
  </section>;
}
