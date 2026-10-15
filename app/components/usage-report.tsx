"use client";
import {useCallback,useEffect,useRef,useState} from 'react';
import {api} from '@/lib/contracts';
import {usageQuery,usageReport,type UsageReport as Report} from '@/lib/usage-contract';
function initialRange(){const today=new Date();const to=new Date(Date.UTC(today.getUTCFullYear(),today.getUTCMonth(),today.getUTCDate()+1));return {from:new Date(to.getTime()-7*86400000).toISOString().slice(0,10),to:to.toISOString().slice(0,10)};}
const number=(value:string)=>BigInt(value).toLocaleString();
export function UsageReport({org}:{org:string}){
  const [range,setRange]=useState(initialRange),[report,setReport]=useState<Report|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState('');
  const request=useRef<AbortController|null>(null);
  const load=useCallback(async(q:{from:string;to:string})=>{
    request.current?.abort();const controller=new AbortController();request.current=controller;setReport(null);setError('');setLoading(true);
    try{
      const parsed=usageQuery.safeParse(q);if(!parsed.success)throw new Error('Choose valid UTC dates with an end after the start, at most 31 days apart.');
      const query=parsed.data,raw=await api<unknown>(`/organizations/${org}/usage?${new URLSearchParams(query)}`,'GET',undefined,AbortSignal.any([controller.signal,AbortSignal.timeout(12000)]));
      const validated=usageReport.safeParse(raw);if(!validated.success)throw new Error('Usage report format could not be verified. Retry or contact support.');
      const result=validated.data;if(result.organizationId!==org||result.range.from!==query.from||result.range.to!==query.to)throw new Error('Usage report scope could not be verified.');
      if(!controller.signal.aborted)setReport(result);
    }catch(e){if(!controller.signal.aborted)setError(e instanceof Error?e.message:'Usage report unavailable');}
    finally{if(request.current===controller){request.current=null;setLoading(false);}}
  },[org]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- Load fresh remote data on mounting the organization-keyed panel.
  useEffect(()=>{void load(initialRange());return()=>request.current?.abort();},[load]);
  return <section aria-label="Usage report"><h2>Usage report</h2>
    <p>Only resources you can currently access are counted, including archived conversations. This is not a complete workspace total. Dates use UTC; the end date is exclusive. Select 1–31 days.</p>
    <form onSubmit={e=>{e.preventDefault();void load(range);}}>
      <label>Usage from (UTC)<input type="date" required value={range.from} onChange={e=>setRange(old=>({...old,from:e.target.value}))}/></label>
      <label>Usage before (UTC)<input type="date" required value={range.to} onChange={e=>setRange(old=>({...old,to:e.target.value}))}/></label>
      <button className="secondary" disabled={loading}>Refresh usage report</button>
    </form>
    {loading&&<p role="status">Loading usage report…</p>}{error&&<><p role="alert">{error}</p><p>Check the date range and retry with Refresh usage report.</p></>}
    {report&&<><p role="status">Report for {report.range.from} to {report.range.to} (exclusive), generated <time dateTime={report.generatedAt}>{new Date(report.generatedAt).toLocaleString()}</time>.</p>
      <article className="result-card"><h3>Activity in the selected range</h3><dl>
        <dt>Retained messages created</dt><dd>{number(report.totals.messagesCreated)}</dd><dt>Distinct message authors</dt><dd>{number(report.totals.activeAuthors)}</dd>
        <dt>Scheduled meetings starting in range</dt><dd>{number(report.totals.scheduledMeetings)}</dd><dt>Scheduled duration (seconds)</dt><dd>{report.totals.scheduledSeconds}</dd>
      </dl><p>Includes replies; deleted messages and canceled meetings are excluded. Meetings require organizer or invitee access. Scheduled duration is the full planned duration, not actual attendance or media usage.</p></article>
      <article className="result-card"><h3>Current authorized storage and conversations</h3><dl>
        <dt>Conversations</dt><dd>{number(report.totals.channels)}</dd><dt>Archived conversations</dt><dd>{number(report.totals.archivedChannels)}</dd>
        <dt>Registered file versions</dt><dd>{number(report.totals.registeredFileVersions)}</dd><dt>Registered file bytes</dt><dd>{number(report.totals.registeredFileBytes)}</dd>
      </dl><p>Current values are not date-filtered. Files include all retained revisions and scan states except deleted; these are logical metadata bytes, not physical storage, backup size or billing.</p></article>
      <details><summary>Daily activity (UTC)</summary>{report.daily.map(day=><article className="result-card" key={day.date}><h3>{day.date}</h3><dl><dt>Messages created</dt><dd>{number(day.messagesCreated)}</dd><dt>Distinct authors</dt><dd>{number(day.activeAuthors)}</dd><dt>Scheduled meetings</dt><dd>{number(day.scheduledMeetings)}</dd><dt>Scheduled seconds</dt><dd>{day.scheduledSeconds}</dd></dl></article>)}<p>Daily distinct authors cannot be summed to obtain the range total.</p></details>
    </>}
    <p>Actual call attendance, media quality and cost reporting are not available yet.</p>
  </section>;
}
