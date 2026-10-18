"use client";
import {useCallback,useEffect,useRef,useState} from 'react';
import {z} from 'zod';
import {api,type Person} from '@/lib/contracts';
import {GroupAccess} from './group-access';
const snapshot=z.object({id:z.uuid(),name:z.string(),kind:z.enum(['direct','group']),revision:z.number().int().positive(),archived:z.boolean(),can_manage:z.boolean(),participants:z.array(z.object({id:z.uuid(),name:z.string()}))});
type Chat=z.infer<typeof snapshot>;
export function ChatManagement({id,onSaved,onLeft,people,userId}:{id:string;onSaved:()=>Promise<void>;onLeft:()=>Promise<void>;people:Person[];userId:string}){
  const [chat,setChat]=useState<Chat|null>(null),[name,setName]=useState(''),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[confirm,setConfirm]=useState(false);
  const request=useRef<AbortController|null>(null);
  const load=useCallback(async()=>{
    request.current?.abort();const controller=new AbortController();request.current=controller;setLoading(true);setError('');setChat(null);setConfirm(false);setNotice('');
    try{const result=snapshot.parse(await api(`/channels/${id}/chat`,'GET',undefined,AbortSignal.any([controller.signal,AbortSignal.timeout(12000)])));if(result.id!==id)throw new Error('Chat scope could not be verified');if(!controller.signal.aborted){setChat(result);setName(result.name);}}
    catch(e){if(!controller.signal.aborted)setError(e instanceof Error?e.message:'Participants unavailable');}
    finally{if(request.current===controller){request.current=null;setLoading(false);}}
  },[id]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- Hydrate the resource-keyed remote chat snapshot.
  useEffect(()=>{void load();return()=>request.current?.abort();},[load]);
  const mounted=useRef(true);useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  return <section aria-label="Chat participants"><h3>Chat participants</h3>
    <button className="secondary" disabled={loading||busy} onClick={()=>void load()}>Refresh participants</button>
    {loading&&<p role="status">Loading participants…</p>}{error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
    {chat&&<><ul>{chat.participants.map(p=><li key={p.id}>{p.name}</li>)}</ul><p>Current active participants can read the retained conversation history.</p>
      {chat.kind==='group'&&<><form onSubmit={async e=>{e.preventDefault();setBusy(true);setError('');setNotice('');try{await api(`/channels/${id}/group-name`,'PATCH',{name,revision:chat.revision});if(mounted.current){await load();await onSaved();if(mounted.current)setNotice('Group name saved.');}}catch(e){if(mounted.current)setError(e instanceof Error?e.message:'Group name could not be saved');}finally{if(mounted.current)setBusy(false);}}}>
        <label>Group name<input required maxLength={160} value={name} disabled={busy||chat.archived} onChange={e=>setName(e.target.value)}/></label><button className="secondary" disabled={busy||chat.archived}>Save group name</button>
      </form>{chat.archived&&<p>Archived groups cannot be renamed.</p>}
      {chat.can_manage&&<GroupAccess key={chat.revision} id={id} revision={chat.revision} participants={chat.participants} people={people} userId={userId} disabled={busy||chat.archived} onChanged={async()=>{await load();await onSaved();}}/>}
      <p>Leaving removes your access and personal draft. Your existing messages remain available to the other participants. A group administrator must add you again to rejoin.</p>
      {!confirm?<button className="secondary" disabled={busy} onClick={()=>{setConfirm(true);setNotice('');}}>Leave group</button>:<div><p>Leave this group now?</p><button className="secondary" disabled={busy} onClick={async()=>{setBusy(true);setError('');try{await api(`/channels/${id}/leave-group`,'POST',{});await onLeft();}catch(e){if(mounted.current)setError(e instanceof Error?e.message:'Leaving could not be confirmed. Refresh participants or the workspace before retrying.');}finally{if(mounted.current)setBusy(false);}}}>Confirm leave group</button><button className="secondary" disabled={busy} onClick={()=>setConfirm(false)}>Stay in group</button></div>}
      </>}
    </>}
  </section>;
}
