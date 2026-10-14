"use client";
import {useState} from 'react';
import {api,type Meeting} from '@/lib/contracts';
import {Modal} from './primitives';
function localInput(iso:string){const d=new Date(iso);return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,19);}
export function MeetingEditor({org,meeting,onClose,onSaved}:{org:string;meeting:Meeting;onClose:()=>void;onSaved:()=>Promise<void>}){
  const [title,setTitle]=useState(meeting.title),[description,setDescription]=useState(meeting.description),[start,setStart]=useState(localInput(meeting.starts_at)),[end,setEnd]=useState(localInput(meeting.ends_at)),[busy,setBusy]=useState(false),[error,setError]=useState('');
  return <Modal title="Edit meeting" onClose={()=>{if(!busy)onClose();}}><form className="modal-body" onSubmit={async e=>{e.preventDefault();setBusy(true);setError('');try{await api(`/organizations/${org}/meetings/${meeting.id}/details`,'PUT',{revision:meeting.revision,title,description,startsAt:start===localInput(meeting.starts_at)?meeting.starts_at:new Date(start).toISOString(),endsAt:end===localInput(meeting.ends_at)?meeting.ends_at:new Date(end).toISOString(),timezone:meeting.timezone});await onSaved();onClose();}catch(e){setError(e instanceof Error?e.message:'Meeting could not be saved');}finally{setBusy(false);}}}>
    <p>Times entered in {Intl.DateTimeFormat().resolvedOptions().timeZone}. Changing the time resets attendee responses to pending. Attendees stay unchanged.</p>
    <label>Meeting title<input required maxLength={500} value={title} onChange={e=>setTitle(e.target.value)}/></label>
    <label>Description<textarea maxLength={4000} value={description} onChange={e=>setDescription(e.target.value)}/></label>
    <label>Starts<input type="datetime-local" step="1" required value={start} onChange={e=>setStart(e.target.value)}/></label>
    <label>Ends<input type="datetime-local" step="1" required value={end} onChange={e=>setEnd(e.target.value)}/></label>
    {error&&<p role="alert">{error}</p>}<button className="primary" disabled={busy}>{busy?'Saving…':'Save meeting changes'}</button>
  </form></Modal>;
}
