"use client";
import {useEffect,useState} from 'react';
import {api} from '@/lib/contracts';
type Reminder={id:string;title:string;starts_at:string;timezone:string;minutes:number};
export function MeetingReminders({org}:{org:string}){
  const [items,setItems]=useState<Reminder[]>([]),[error,setError]=useState(''),[refresh,setRefresh]=useState(0),[busy,setBusy]=useState<string|null>(null);
  useEffect(()=>{let pending=false;const controller=new AbortController();const poll=async()=>{if(pending)return;pending=true;try{const r=await api<{items:Reminder[]}>(`/organizations/${org}/meeting-reminders`,'GET',undefined,AbortSignal.any([controller.signal,AbortSignal.timeout(8000)]));if(!controller.signal.aborted){setItems(r.items);setError('');}}catch{if(!controller.signal.aborted){setItems([]);setError('Meeting reminders unavailable. Retrying automatically.');}}finally{pending=false;}};void poll();const timer=setInterval(()=>void poll(),10000),visible=()=>{if(document.visibilityState==='visible')void poll();};document.addEventListener('visibilitychange',visible);return()=>{controller.abort();clearInterval(timer);document.removeEventListener('visibilitychange',visible);};},[org,refresh]);
  if(!items.length&&!error)return null;
  return <section aria-label="Meeting reminders" className="content-pad">{error&&<p role="status">{error}</p>}{items.map(m=><div className="notice" key={m.id}><div><strong>{m.title}</strong><p>Starts {new Intl.DateTimeFormat(undefined,{timeZone:m.timezone,dateStyle:'medium',timeStyle:'short'}).format(new Date(m.starts_at))} · {m.timezone}</p><button className="secondary" disabled={busy!==null} onClick={async()=>{setBusy(m.id);try{await api(`/organizations/${org}/meetings/${m.id}/reminder/dismiss`,'POST',{startsAt:m.starts_at});setItems(old=>old.filter(i=>i.id!==m.id));setError('');}catch{setItems([]);setError('Reminder changed or unavailable. Refreshing.');}finally{setBusy(null);setRefresh(n=>n+1);}}}>Dismiss reminder</button></div></div>)}</section>;
}
export function MeetingReminderControl({org,id,minutes,onSaved,report}:{org:string;id:string;minutes:number;onSaved:()=>Promise<void>;report:(e:unknown)=>void}){
  const [busy,setBusy]=useState(false);
  return <label>In-app reminder<select aria-label="In-app reminder" disabled={busy} value={minutes} onChange={async e=>{setBusy(true);try{await api(`/organizations/${org}/meetings/${id}/reminder`,'PUT',{minutes:Number(e.target.value)});await onSaved();}catch(e){report(e);}finally{setBusy(false);}}}><option value={0}>Off</option>{[5,15,30,60].map(n=><option key={n} value={n}>{n} minutes before</option>)}</select></label>;
}
