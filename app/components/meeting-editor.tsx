"use client";
import {useState} from 'react';
import {api,type Meeting,type Person} from '@/lib/contracts';
import {Modal} from './primitives';
import {MeetingTimezone} from './meeting-timezone';
import {resolveMeetingTime,meetingLocalTime,type RepeatedTime} from '@/lib/meeting-time';
export function MeetingEditor({org,meeting,people,onClose,onSaved}:{org:string;meeting:Meeting;people:Person[];onClose:()=>void;onSaved:()=>Promise<void>}){
  const [scope,setScope]=useState<'occurrence'|'series'|'future'>('occurrence');
  const [zone,setZone]=useState(meeting.timezone),[choice,setChoice]=useState<RepeatedTime>('reject');
  const [attendees,setAttendees]=useState((meeting.attendee_ids??[]).filter(id=>id!==meeting.organizer_id));
  const [title,setTitle]=useState(meeting.title),[description,setDescription]=useState(meeting.description),[start,setStart]=useState(meetingLocalTime(meeting.starts_at,meeting.timezone)),[end,setEnd]=useState(meetingLocalTime(meeting.ends_at,meeting.timezone)),[busy,setBusy]=useState(false),[error,setError]=useState('');
  return <Modal title="Edit meeting" onClose={()=>{if(!busy)onClose();}}><form className="modal-body" onSubmit={async e=>{e.preventDefault();setBusy(true);setError('');try{if(scope!=='occurrence'){await api(`/organizations/${org}/meetings/${meeting.id}/series/details`,'PUT',{revision:meeting.series_revision,title,description,attendees,futureOnly:scope==='future'});}else{await api(`/organizations/${org}/meetings/${meeting.id}/details`,'PUT',{revision:meeting.revision,title,description,attendees,startsAt:zone===meeting.timezone&&choice==='reject'&&start===meetingLocalTime(meeting.starts_at,meeting.timezone)?meeting.starts_at:resolveMeetingTime(start,zone,choice),endsAt:zone===meeting.timezone&&choice==='reject'&&end===meetingLocalTime(meeting.ends_at,meeting.timezone)?meeting.ends_at:resolveMeetingTime(end,zone,choice),timezone:zone});}await onSaved();onClose();}catch(e){setError(e instanceof Error?e.message:'Meeting could not be saved');}finally{setBusy(false);}}}>
    {meeting.series_id&&<><label htmlFor="meeting-edit-scope">Edit scope</label><select id="meeting-edit-scope" value={scope} onChange={e=>setScope(e.target.value as typeof scope)}><option value="occurrence">This occurrence</option><option value="series">All noncancelled occurrences</option><option value="future">Upcoming noncancelled occurrences</option></select><p>{scope==='future'?'Only occurrences that have not started at server time will change. Past and in-progress meetings are preserved. Attendee selections come from this occurrence.':scope==='series'?'Title, description and attendee selections replace every noncancelled occurrence. Times stay unchanged. Cancelled occurrences are preserved. The initial attendee selections come from this occurrence.':'You are editing this occurrence only.'}</p></>}
    <p>Times entered in {zone}. Changing the time resets attendee responses to pending. New attendees start pending; removed attendees lose calendar access.</p>
    <label>Meeting title<input required maxLength={500} value={title} onChange={e=>setTitle(e.target.value)}/></label>
    <label>Description<textarea maxLength={4000} value={description} onChange={e=>setDescription(e.target.value)}/></label>
    {scope==='occurrence'&&<><MeetingTimezone zone={zone} onZone={setZone} choice={choice} onChoice={setChoice}/>
    <label>Starts<input type="datetime-local" step="1" required value={start} onChange={e=>setStart(e.target.value)}/></label>
    <label>Ends<input type="datetime-local" step="1" required value={end} onChange={e=>setEnd(e.target.value)}/></label></>}
    <fieldset><legend>Meeting attendees</legend>{[...people.filter(p=>p.id!==meeting.organizer_id).map(p=>({id:p.id,name:p.name})),...attendees.filter(id=>!people.some(p=>p.id===id)).map(id=>({id,name:`Unavailable member ${id}`}))].map(p=><label className="check-label" key={p.id}><input type="checkbox" checked={attendees.includes(p.id)} onChange={e=>setAttendees(current=>e.target.checked?[...current,p.id]:current.filter(id=>id!==p.id))}/>{p.name}</label>)}</fieldset>
    {error&&<p role="alert">{error}</p>}<button className="primary" disabled={busy}>{busy?'Saving…':'Save meeting changes'}</button>
  </form></Modal>;
}
