import {Temporal} from '@js-temporal/polyfill';
export type RepeatedTime='reject'|'earlier'|'later';
export function resolveMeetingTime(value:string,timezone:string,choice:RepeatedTime='reject'){
  try{new Intl.DateTimeFormat('en',{timeZone:timezone});}catch{throw new Error('Choose a valid IANA timezone, such as America/New_York.');}
  let local:Temporal.PlainDateTime;
  try{if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?$/.test(value))throw new Error();local=Temporal.PlainDateTime.from(value,{overflow:'reject'});}catch{throw new Error('Enter a valid local date and time.');}
  const earlier=local.toZonedDateTime(timezone,{disambiguation:'earlier'}),later=local.toZonedDateTime(timezone,{disambiguation:'later'});
  if(!earlier.toPlainDateTime().equals(local)||!later.toPlainDateTime().equals(local))throw new Error('This local time does not exist because the clock changes. Choose another time.');
  if(earlier.epochNanoseconds!==later.epochNanoseconds&&choice==='reject')throw new Error('This local time occurs twice. Choose the earlier or later occurrence.');
  return (choice==='later'?later:earlier).toInstant().toString({fractionalSecondDigits:3});
}
export function meetingLocalTime(instant:string,timezone:string){return Temporal.Instant.from(instant).toZonedDateTimeISO(timezone).toPlainDateTime().toString({smallestUnit:'second'});}
