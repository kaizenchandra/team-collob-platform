export function isQuietHours(timezone:string,start:string,end:string,now=new Date()){
  const parts=new Intl.DateTimeFormat('en-GB',{timeZone:timezone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now);
  const current=parts.find(p=>p.type==='hour')!.value+':'+parts.find(p=>p.type==='minute')!.value;
  return start===end || (start<end?current>=start&&current<end:current>=start||current<end);
}
