"use client";
import { useEffect, useState } from "react";
import { api } from "../../lib/contracts";
export function MentionPicker({channelId, select}: {channelId: string; select: (person: {id:string;name:string})=>void}) {
  const [members,setMembers]=useState<{id:string;name:string}[]>([]), [error,setError]=useState(""), [loading,setLoading]=useState(true), [attempt,setAttempt]=useState(0), [search,setSearch]=useState("");
  useEffect(()=>{
    let active=true;
    api<{members:{id:string;name:string}[]}>(`/channels/${channelId}/members`).then(r=>{if(active)setMembers(r.members);}).catch(()=>{if(active)setError("Channel members could not be loaded. Check your access and retry.");}).finally(()=>{if(active)setLoading(false);});
    return ()=>{active=false;};
  },[channelId,attempt]);
  return <div className="modal-body">
    <p>Select a person who can access this conversation. Mentions from other people appear in activity; email and push delivery are not enabled.</p>
    <label>Find a channel member<input value={search} onChange={e=>setSearch(e.target.value)} maxLength={100}/></label>
    {loading ? <p role="status">Loading channel members…</p> : error ? <div role="alert">{error}<button onClick={()=>{setError("");setLoading(true);setAttempt(v=>v+1);}}>Retry members</button></div> : members.filter(p=>p.name.toLowerCase().includes(search.toLowerCase())).map(p=><button type="button" className="person person-button" key={p.id} onClick={()=>select(p)}>{p.name}</button>)}
    {!loading && !error && !members.some(p=>p.name.toLowerCase().includes(search.toLowerCase())) && <p>No matching channel members.</p>}
  </div>;
}
