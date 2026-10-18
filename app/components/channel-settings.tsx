"use client";
import {useCallback,useEffect,useRef,useState,useId} from 'react';
import {z} from 'zod';
import {api} from '@/lib/contracts';
const snapshot=z.object({id:z.uuid(),name:z.string(),description:z.string(),archived:z.boolean(),kind:z.enum(['standard','private','shared']),revision:z.number().int().positive()});
type Settings=z.infer<typeof snapshot>;
export function ChannelSettings({id,onSaved}:{id:string;onSaved:()=>Promise<void>}){
  const [settings,setSettings]=useState<Settings|null>(null),[name,setName]=useState(''),[description,setDescription]=useState(''),[archived,setArchived]=useState(false),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const fieldId=useId();
  const request=useRef<AbortController|null>(null),mounted=useRef(true);
  const load=useCallback(async()=>{
    request.current?.abort();const controller=new AbortController();request.current=controller;setLoading(true);setError('');setNotice('');setSettings(null);
    try{const result=snapshot.parse(await api(`/channels/${id}/settings`,'GET',undefined,AbortSignal.any([controller.signal,AbortSignal.timeout(12000)])));if(result.id!==id)throw new Error('Channel scope could not be verified');if(!controller.signal.aborted){setSettings(result);setName(result.name);setDescription(result.description);setArchived(result.archived);}}
    catch(e){if(!controller.signal.aborted)setError(e instanceof Error?e.message:'Channel settings unavailable');}
    finally{if(request.current===controller){request.current=null;setLoading(false);}}
  },[id]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- Load the organization/resource-keyed authoritative settings.
  useEffect(()=>{mounted.current=true;void load();return()=>{mounted.current=false;request.current?.abort();};},[load]);
  return <section aria-label="Channel settings"><h3>Channel settings</h3><p>Workspace owners and admins with channel access can edit these details. Refresh replaces unsaved edits with the latest settings.</p>
    <button className="secondary" disabled={loading||busy} onClick={()=>void load()}>Refresh channel settings</button>
    {loading&&<p role="status">Loading channel settings…</p>}{error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
    {settings&&<form onSubmit={async e=>{e.preventDefault();setBusy(true);setError('');setNotice('');try{const result=z.object({ok:z.literal(true),revision:z.number().int().positive(),changed:z.boolean()}).parse(await api(`/channels/${id}/details`,'PATCH',{name,description,archived,revision:settings.revision}));if(mounted.current){setSettings({...settings,name:name.trim(),description,archived,revision:result.revision});setName(name.trim());setNotice('Channel settings saved.');await onSaved();}}catch(e){if(mounted.current)setError(e instanceof Error?e.message:'Channel update could not be confirmed. Refresh before retrying.');}finally{if(mounted.current)setBusy(false);}}}>
      <label htmlFor={`${fieldId}-name`}>Channel name</label><input id={`${fieldId}-name`} required maxLength={160} disabled={busy} value={name} onChange={e=>setName(e.target.value)}/>
      <label htmlFor={`${fieldId}-description`}>Channel description</label><textarea id={`${fieldId}-description`} maxLength={1000} disabled={busy} value={description} onChange={e=>setDescription(e.target.value)}/>
      <label className="check-label"><input type="checkbox" style={{flexShrink:0,width:16,height:16}} disabled={busy} checked={archived} onChange={e=>setArchived(e.target.checked)}/>Archive channel</label>
      <p>Archived channels retain history and saved drafts. New messages are blocked. Restore the parent team first if it is archived.</p>
      <button className="secondary" disabled={busy}>Save channel settings</button>
    </form>}
  </section>;
}
