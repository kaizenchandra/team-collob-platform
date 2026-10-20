"use client";
import { useEffect, useState } from "react";
import {z} from 'zod';
import { api } from "../../lib/contracts";
const snapshot=z.object({members:z.array(z.object({id:z.uuid(),name:z.string().min(1)}))}).refine(value=>new Set(value.members.map(person=>person.id)).size===value.members.length,'Duplicate member identities');
export function MentionPicker({channelId, select}: {channelId: string; select: (person: {id:string;name:string})=>void}) {
  const [members,setMembers]=useState<z.infer<typeof snapshot>['members']>([]), [error,setError]=useState(""), [loading,setLoading]=useState(true), [attempt,setAttempt]=useState(0), [search,setSearch]=useState("");
  useEffect(()=>{
    let active=true;const controller=new AbortController();
    void api(`/channels/${channelId}/members`,'GET',undefined,AbortSignal.any([controller.signal,AbortSignal.timeout(8000)]))
      .then(result=>{const data=snapshot.parse(result);if(active&&!controller.signal.aborted)setMembers(data.members);})
      .catch(()=>{if(active&&!controller.signal.aborted){setMembers([]);setError("Channel members could not be loaded. Check your access and retry.");}})
      .finally(()=>{if(active&&!controller.signal.aborted)setLoading(false);});
    return ()=>{active=false;controller.abort();};
  },[channelId,attempt]);
  const matches=members.filter(person=>person.name.toLowerCase().includes(search.toLowerCase()));
  return <div className="modal-body">
    <p>Select a person who can access this conversation. Mentions from other people appear in activity; email and push delivery are not enabled.</p>
    <label>Find a channel member<input value={search} onChange={e=>setSearch(e.target.value)} maxLength={100}/></label>
    {loading ? <p role="status">Loading channel members…</p> : error ? <div role="alert">{error}<button type="button" onClick={()=>{setError("");setMembers([]);setLoading(true);setAttempt(v=>v+1);}}>Retry members</button></div> : matches.map(person=><button type="button" className="person person-button" key={person.id} onClick={()=>select(person)}>{person.name}</button>)}
    {!loading && !error && !matches.length && <p>{members.length?'No matching channel members.':'No channel members are available.'}</p>}
  </div>;
}
