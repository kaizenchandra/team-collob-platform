"use client";
import {useCallback,useEffect,useRef,useState} from 'react';
import {z} from 'zod';
import {api,type Person} from '@/lib/contracts';
import {GroupAccess} from './group-access';
const snapshot=z.object({id:z.uuid(),kind:z.enum(['private','shared']),revision:z.number().int().positive(),archived:z.boolean(),members:z.array(z.object({id:z.uuid(),name:z.string(),active:z.boolean()})).max(1000)});
type Access=z.infer<typeof snapshot>;
export function ChannelAccess({id,people,userId,onSaved}:{id:string;people:Person[];userId:string;onSaved:()=>Promise<void>}){
  const [data,setData]=useState<Access|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState('');const request=useRef<AbortController|null>(null);
  const load=useCallback(async()=>{
    request.current?.abort();const controller=new AbortController();request.current=controller;setLoading(true);setData(null);setError('');
    try{const result=snapshot.parse(await api(`/channels/${id}/access`,'GET',undefined,AbortSignal.any([controller.signal,AbortSignal.timeout(12000)])));if(result.id!==id)throw new Error('Channel access scope could not be verified');if(!controller.signal.aborted)setData(result);}
    catch(e){if(!controller.signal.aborted)setError(e instanceof Error?e.message:'Channel access unavailable');}
    finally{if(request.current===controller){request.current=null;setLoading(false);}}
  },[id]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- Hydrate the current resource-keyed access snapshot.
  useEffect(()=>{void load();return()=>request.current?.abort();},[load]);
  return <section aria-label="Channel access"><h3>Channel access</h3><button className="secondary" disabled={loading} onClick={()=>void load()}>Refresh channel access</button>
    {loading&&<p role="status">Loading channel access…</p>}{error&&<p role="alert">{error}</p>}
    {data&&<><ul>{data.members.map(p=><li key={p.id}>{p.name}{p.active?'':' (inactive)'}</li>)}</ul>
      <p>Explicit membership grants retained history and files. Existing permissions also apply to tasks and forms. This does not join a team or grant access to another workspace.</p>
      {data.archived&&<p>Restore the channel before changing membership.</p>}
      <GroupAccess key={data.revision} scope="channel" id={id} revision={data.revision} participants={data.members} people={people} userId={userId} disabled={data.archived} onChanged={async()=>{await load();await onSaved();}}/>
    </>}
  </section>;
}
