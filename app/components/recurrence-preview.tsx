"use client";
import {useState} from 'react';
import {meetingOccurrences,type Recurrence} from '@/lib/meeting-recurrence';
type Schedule={startsAt:string;endsAt:string;timezone:string;rule:Recurrence};
export function RecurrencePreview({signature,getSchedule,editing=false}:{signature:string;getSchedule:()=>Schedule;editing?:boolean}){
  const [result,setResult]=useState<{signature:string;timezone:string;slots:ReturnType<typeof meetingOccurrences>;error:string}|null>(null);
  const current=result?.signature===signature?result:null;
  return <section aria-label="Recurrence preview">
    <button type="button" className="secondary" onClick={()=>{try{const s=getSchedule();const slots=meetingOccurrences(s.startsAt,s.endsAt,s.timezone,s.rule);setResult({signature,timezone:s.timezone,slots,error:''});}catch(e){setResult({signature,timezone:'',slots:[],error:e instanceof Error?e.message:'Dates could not be previewed'});}}}>Preview occurrences</button>
    <p>{editing?'These are proposed canonical slots. Cancelled entries and preserved historical exceptions may differ; the server checks current permissions, revision and upcoming eligibility when saving.':'Review proposed dates before scheduling. The server validates the series again when you save.'}</p>
    {current?.error&&<p role="alert">{current.error}</p>}
    {current&&!current.error&&<><p role="status">{current.slots.length} proposed occurrences · {current.timezone}</p><ol tabIndex={0} aria-label="Proposed occurrence dates" style={{maxHeight:240,overflowY:'auto',paddingInlineStart:28}}>{current.slots.map((slot,i)=>{
      const format=(utc:string)=>new Intl.DateTimeFormat(undefined,{timeZone:current.timezone,dateStyle:'medium',timeStyle:'long'}).format(new Date(utc));
      return <li key={i}><time dateTime={slot.startsAt}>{format(slot.startsAt)}</time> – <time dateTime={slot.endsAt}>{format(slot.endsAt)}</time></li>;
    })}</ol></>}
  </section>;
}
