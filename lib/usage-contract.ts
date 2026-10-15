import {z} from 'zod';
const dayMilliseconds=86400000;
export const usageQuery=z.object({from:z.iso.date(),to:z.iso.date()}).strict().superRefine((q,ctx)=>{
  const days=(Date.parse(`${q.to}T00:00:00Z`)-Date.parse(`${q.from}T00:00:00Z`))/dayMilliseconds;
  if(!Number.isInteger(days)||days<1||days>31)ctx.addIssue({code:'custom',message:'Choose a positive UTC date range of at most 31 days'});
});
const integer=z.string().regex(/^(0|[1-9][0-9]*)$/),seconds=z.string().regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/);
const activity=z.object({messagesCreated:integer,activeAuthors:integer,scheduledMeetings:integer,scheduledSeconds:seconds}).strict();
export const usageReport=z.object({organizationId:z.uuid(),generatedAt:z.iso.datetime(),scope:z.literal('caller-authorized-resources'),range:usageQuery,
  totals:activity.extend({channels:integer,archivedChannels:integer,registeredFileVersions:integer,registeredFileBytes:integer}).strict(),
  daily:z.array(activity.extend({date:z.iso.date()}).strict()).min(1).max(31),
}).strict().superRefine((r,ctx)=>{
  const start=Date.parse(`${r.range.from}T00:00:00Z`),count=(Date.parse(`${r.range.to}T00:00:00Z`)-start)/dayMilliseconds;
  if(r.daily.length!==count||r.daily.some((d,i)=>d.date!==new Date(start+i*dayMilliseconds).toISOString().slice(0,10)))ctx.addIssue({code:'custom',message:'Usage report buckets do not match its range'});
});
export type UsageReport=z.infer<typeof usageReport>;
