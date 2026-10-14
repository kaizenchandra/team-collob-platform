"use client";
import {useState} from 'react';
import {api,type Meeting,type Person} from '@/lib/contracts';
import {Modal} from './primitives';
function localInput(iso:string){const d=new Date(iso);return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,19);}
export function MeetingEditor({org,meeting,people,onClose,onSaved}:{org:string;meeting:Meeting;people:Person[];onClose:()=>void;onSaved:()=>Promise<void>}){
  const [attendees,setAttendees]=useState((meeting.attendee_ids??[]).filter(id=>id!==meeting.organizer_id));
  const [title,setTitle]=useState(meeting.title),[description,setDescription]=useState(meeting.description),[start,setStart]=useState(localInput(meeting.starts_at)),[end,setEnd]=useState(localInput(meeting.ends_at)),[busy,setBusy]=useState(false),[error,setError]=useState('');
  return <Modal title="Edit meeting" onClose={()=>{if(!busy)onClose();}}><form className="modal-body" onSubmit={async e=>{e.preventDefault();setBusy(true);setError('');try{await api(`/organizations/${org}/meetings/${meeting.id}/details`,'PUT',{revision:meeting.revision,title,description,attendees,startsAt:start===localInput(meeting.starts_at)?meeting.starts_at:new Date(start).toISOString(),endsAt:end===localInput(meeting.ends_at)?meeting.ends_at:new Date(end).toISOString(),timezone:meeting.timezone});await onSaved();onClose();}catch(e){setError(e instanceof Error?e.message:'Meeting could not be saved');}finally{setBusy(false);}}}>
    <p>Times entered in {Intl.DateTimeFormat().resolvedOptions().timeZone}. Changing the time resets attendee responses to pending. New attendees start pending; removed attendees lose calendar access.</p>
    <label>Meeting title<input required maxLength={500} value={title} onChange={e=>setTitle(e.target.value)}/></label>
    <label>Description<textarea maxLength={4000} value={description} onChange={e=>setDescription(e.target.value)}/></label>
    <label>Starts<input type="datetime-local" step="1" required value={start} onChange={e=>setStart(e.target.value)}/></label>
    <label>Ends<input type="datetime-local" step="1" required value={end} onChange={e=>setEnd(e.target.value)}/></label>
    <fieldset><legend>Meeting attendees</legend>{[...people.filter(p=>p.id!==meeting.organizer_id).map(p=>({id:p.id,name:p.name})),...attendees.filter(id=>!people.some(p=>p.id===id)).map(id=>({id,name:`Unavailable member ${id}`}))].map(p=><label className="check-label" key={p.id}><input type="checkbox" checked={attendees.includes(p.id)} onChange={e=>setAttendees(current=>e.target.checked?[...current,p.id]:current.filter(id=>id!==p.id))}/>{p.name}</label>)}</fieldset>
    {error&&<p role="alert">{error}</p>}<button className="primary" disabled={busy}>{busy?'Saving…':'Save meeting changes'}</button>
  </form></Modal>;
}
