"use client";
import {AttendeePicker} from "./attendee-picker";
import {SchedulingAvailability} from "./calendar-settings";
import {useState} from 'react';
import {api,type Meeting,type Person} from '@/lib/contracts';
import {Modal} from './primitives';
import {MeetingTimezone} from './meeting-timezone';
import {resolveMeetingTime,meetingLocalTime,type RepeatedTime} from '@/lib/meeting-time';
export function MeetingEditor({org,meeting,people,onClose,onSaved}:{org:string;meeting:Meeting;people:Person[];onClose:()=>void;onSaved:()=>Promise<void>}){
  const [location,setLocation]=useState(meeting.location??''),[meetingType,setMeetingType]=useState(meeting.meeting_type??'video');
  const [scope,setScope]=useState<'occurrence'|'series'|'future'>('occurrence');
  const [zone,setZone]=useState(meeting.timezone),[choice,setChoice]=useState<RepeatedTime>('reject');
  const [attendees,setAttendees]=useState((meeting.attendee_ids??[]).filter(id=>id!==meeting.organizer_id));
  const [title,setTitle]=useState(meeting.title),[description,setDescription]=useState(meeting.description),[start,setStart]=useState(meetingLocalTime(meeting.starts_at,meeting.timezone)),[end,setEnd]=useState(meetingLocalTime(meeting.ends_at,meeting.timezone)),[busy,setBusy]=useState(false),[error,setError]=useState('');
  return <Modal title="Edit meeting" onClose={()=>{if(!busy)onClose();}}><form className="modal-body" onSubmit={async e=>{e.preventDefault();setBusy(true);setError('');try{if(scope!=='occurrence'){await api(`/organizations/${org}/meetings/${meeting.id}/series/details`,'PUT',{revision:meeting.series_revision,title,description,attendees,futureOnly:scope==='future'});}else{await api(`/organizations/${org}/meetings/${meeting.id}/details`,'PUT',{revision:meeting.revision,title,description,attendees,location,meetingType,startsAt:zone===meeting.timezone&&choice==='reject'&&start===meetingLocalTime(meeting.starts_at,meeting.timezone)?meeting.starts_at:resolveMeetingTime(start,zone,choice),endsAt:zone===meeting.timezone&&choice==='reject'&&end===meetingLocalTime(meeting.ends_at,meeting.timezone)?meeting.ends_at:resolveMeetingTime(end,zone,choice),timezone:zone});}await onSaved();onClose();}catch(e){setError(e instanceof Error?e.message:'Meeting could not be saved');}finally{setBusy(false);}}}>
    {meeting.series_id&&<><label htmlFor="meeting-edit-scope">Edit scope</label><select id="meeting-edit-scope" value={scope} onChange={e=>setScope(e.target.value as typeof scope)}><option value="occurrence">This occurrence</option><option value="series">All noncancelled occurrences</option><option value="future">Upcoming noncancelled occurrences</option></select><p>{scope==='future'?'Only occurrences that have not started at server time will change. Past and in-progress meetings are preserved. Attendee selections come from this occurrence.':scope==='series'?'Title, description and attendee selections replace every noncancelled occurrence. Times stay unchanged. Cancelled occurrences are preserved. The initial attendee selections come from this occurrence.':'You are editing this occurrence only.'}</p></>}
    <p>Times entered in {zone}. Changing the time resets attendee responses to pending. New attendees start pending; removed attendees lose calendar access.</p>
    <label>Meeting title<input required maxLength={500} value={title} onChange={e=>setTitle(e.target.value)}/></label>
    <label>Description<textarea maxLength={4000} value={description} onChange={e=>setDescription(e.target.value)}/></label>
    {scope==='occurrence'&&<><label>Meeting type<select value={meetingType} onChange={e=>setMeetingType(e.target.value as typeof meetingType)}><option value="video">Video meeting</option><option value="audio">Audio meeting</option><option value="in_person">In person</option></select></label><label>Location<input maxLength={500} value={location} onChange={e=>setLocation(e.target.value)}/></label><MeetingTimezone zone={zone} onZone={setZone} choice={choice} onChoice={setChoice}/>
    <label>Starts<input type="datetime-local" step="1" required value={start} onChange={e=>setStart(e.target.value)}/></label>
    <label>Ends<input type="datetime-local" step="1" required value={end} onChange={e=>setEnd(e.target.value)}/></label></>}
    <AttendeePicker org={org} value={attendees} onChange={setAttendees} people={people} excludeIds={[meeting.organizer_id]} disabled={busy} refreshKey={error}/>
    <SchedulingAvailability org={org} people={people} userIds={[meeting.organizer_id,...attendees]} start={start} end={end} timezone={zone} excludeMeeting={meeting.id}/>
    {error&&<p role="alert">{error}</p>}<button className="primary" disabled={busy}>{busy?'Saving…':'Save meeting changes'}</button>
  </form></Modal>;
}
