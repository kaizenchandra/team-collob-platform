"use client";
import {useState} from 'react';
import {api,type Channel} from '@/lib/contracts';
export function PostingPolicy({channel,onSaved}:{channel:Channel;onSaved:()=>Promise<void>}){
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  return <section aria-label="Posting policy"><h3>Posting permissions</h3><p>{channel.posting_restricted?'Only workspace owners and admins can post, reply or edit messages.':'Channel members can post, reply and edit their eligible messages.'} Reading, reactions, deletion and drafts keep their existing permissions.</p><button className="secondary" disabled={busy} onClick={async()=>{setBusy(true);setError('');try{await api(`/channels/${channel.id}/posting-policy`,'PATCH',{restricted:!channel.posting_restricted,revision:channel.revision});await onSaved();}catch(e){setError(e instanceof Error?e.message:'Posting policy could not be updated');await onSaved().catch(()=>{});}finally{setBusy(false);}}}>{channel.posting_restricted?'Allow member posting':'Restrict posting to admins'}</button>{error&&<p role="alert">{error}</p>}</section>;
}
