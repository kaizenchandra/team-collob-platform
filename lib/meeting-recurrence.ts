import {Temporal} from '@js-temporal/polyfill';
import {resolveMeetingTime,type RepeatedTime} from './meeting-time.ts';
export type Recurrence={frequency:'daily'|'weekly'|'monthly'|'yearly';interval:number;count:number;repeatedTime:RepeatedTime;monthDayPolicy?:'reject'|'constrain'};
export function meetingOccurrences(startsAt:string,endsAt:string,timezone:string,rule:Recurrence){
  if(!['daily','weekly','monthly','yearly'].includes(rule.frequency)||!Number.isInteger(rule.interval)||rule.interval<1||rule.interval>12||!Number.isInteger(rule.count)||rule.count<2||rule.count>52||!['reject','earlier','later'].includes(rule.repeatedTime))throw new Error('Invalid recurrence rule');
  const policy=rule.monthDayPolicy??'reject';if(!['reject','constrain'].includes(policy))throw new Error('Invalid month-day policy');
  const calendarRule=['monthly','yearly'].includes(rule.frequency),months=rule.interval*(rule.frequency==='yearly'?12:1),step=rule.interval*(rule.frequency==='weekly'?7:1);
  if(calendarRule&&months*(rule.count-1)>60)throw new Error('Monthly/yearly series must span at most 5 calendar years.');
  if(!calendarRule&&step*(rule.count-1)>366)throw new Error('Recurring series must span at most 366 days.');
  const start=Temporal.Instant.from(startsAt).toZonedDateTimeISO(timezone).toPlainDateTime(),end=Temporal.Instant.from(endsAt).toZonedDateTimeISO(timezone).toPlainDateTime();
  return Array.from({length:rule.count},(_,index)=>{
    let from:string,to:string;
    try{
      const localStart=calendarRule?start.add({months:months*index},{overflow:policy}):start.add({days:step*index});
      const localEnd=calendarRule?localStart.add(end.since(start,{largestUnit:'days'})):end.add({days:step*index});
      from=index?resolveMeetingTime(localStart.toString(),timezone,rule.repeatedTime):startsAt;
      to=index?resolveMeetingTime(localEnd.toString(),timezone,rule.repeatedTime):endsAt;
    }catch(e){throw new Error(`Occurrence ${index+1}: ${e instanceof Error?e.message:'Invalid calendar date'}. Choose the last-valid-day policy for missing month dates, or change the anchor.`);}
    if(Temporal.Instant.compare(from,to)>=0)throw new Error('Every occurrence must end after it starts.');return {startsAt:from,endsAt:to};
  });
}
