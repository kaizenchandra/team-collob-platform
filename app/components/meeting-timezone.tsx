"use client";
import {useId} from 'react';
import type {RepeatedTime} from '@/lib/meeting-time';
export function MeetingTimezone({zone,onZone,choice,onChoice}:{zone:string;onZone:(value:string)=>void;choice:RepeatedTime;onChoice:(value:RepeatedTime)=>void}){
  const id=useId();const zones=[...new Set([zone,'UTC',...Intl.supportedValuesOf('timeZone')])];
  return <><label>Scheduling timezone<input required list={id} value={zone} onChange={e=>onZone(e.target.value)} placeholder="America/New_York"/></label><datalist id={id}>{zones.map(z=><option key={z} value={z}/>)}</datalist>
    <label htmlFor={`${id}-repeat`}>Repeated clock time</label><select id={`${id}-repeat`} value={choice} onChange={e=>onChoice(e.target.value as RepeatedTime)}><option value="reject">Require an explicit choice</option><option value="earlier">Earlier occurrence</option><option value="later">Later occurrence</option></select><p>Times use this timezone. Clock-change gaps are rejected. Changing timezone reinterprets the entered times; repeated-time choice applies to both endpoints.</p></>;
}
