"use client";
import {useCallback,useEffect,useRef,useState} from 'react';
import {z} from 'zod';
import {api} from '@/lib/contracts';
const states=z.enum(['queued','preparing','sending','sent','cancelled','dead','uncertain']);
const snapshot=z.object({jobs:z.array(z.object({id:z.uuid(),state:states,attempts:z.number().int().min(0).max(5),last_error:z.string().nullable(),created_at:z.iso.datetime(),accepted_at:z.iso.datetime().nullable()})).max(20)});
const descriptions:Record<z.infer<typeof states>,string>={queued:'Waiting for processing or a scheduled retry.',preparing:'Checking current preferences and accessible unread activity.',sending:'Waiting for the mail transport outcome.',sent:'SMTP accepted the email. Mailbox delivery is not confirmed.',cancelled:'No longer eligible to send.',dead:'Sending stopped after a definitive failure or exhausted retries.',uncertain:'Acceptance is unknown. Held for investigation to avoid duplicate email.'};
const diagnostics:Record<string,string>={preparation_unavailable:'Preparation failed before mail transport; safe retries are bounded.',smtp_unavailable:'Mail transport was unavailable or rejected the request.',retry_exhausted:'The preparation retry limit was reached.',acceptance_unknown:'Automatic resend is disabled because acceptance may have occurred.'};
export function DigestHistory(){
  const [jobs,setJobs]=useState<z.infer<typeof snapshot>['jobs']|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState(false);
  const active=useRef(true),request=useRef<AbortController|null>(null);
  const load=useCallback(async(manual=false)=>{
    request.current?.abort();const controller=new AbortController();request.current=controller;
    if(manual){setLoading(true);setError(false);}
    try{
      const result=snapshot.parse(await api('/digest-jobs','GET',undefined,AbortSignal.any([controller.signal,AbortSignal.timeout(8000)])));
      if(active.current&&!controller.signal.aborted){setJobs(result.jobs);setError(false);}
    }catch{if(active.current&&!controller.signal.aborted){setJobs(null);setError(true);}}
    finally{if(request.current===controller){request.current=null;if(active.current)setLoading(false);}}
  },[]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- Load the bounded remote history on mount; local intent is unchanged.
  useEffect(()=>{active.current=true;void load();const timer=setInterval(()=>{if(!request.current)void load();},5000);return()=>{active.current=false;request.current?.abort();clearInterval(timer);};},[load]);
  return <section className="digest-history" aria-label="Digest delivery history"><h3>Recent digest delivery</h3>
    <p>Your latest 20 jobs across workspaces. This history does not include message text or recipient details.</p>
    <button type="button" className="secondary" onClick={()=>void load(true)}>Refresh digest history</button>
    {loading&&<p role="status">Loading digest history…</p>}
    {error&&<p role="alert">Digest history is unavailable. Refresh to retry; automatic checks continue.</p>}
    {jobs?.map(job=><article className="result-card" key={job.id} aria-label={`Digest job ${job.id}`}><strong>Digest {job.id.slice(0,8)}: {job.state}</strong>
      <p>{descriptions[job.state]}</p><p>Attempts: {job.attempts} of 5 · Created <time dateTime={job.created_at}>{new Date(job.created_at).toLocaleString()}</time></p>
      {job.accepted_at&&<p>SMTP acceptance recorded <time dateTime={job.accepted_at}>{new Date(job.accepted_at).toLocaleString()}</time></p>}
      {job.last_error&&<p>{diagnostics[job.last_error]??'Processing encountered a problem. Check the job outcome above.'}</p>}
    </article>)}
    {jobs?.length===0&&!loading&&!error&&<p>No digest jobs yet.</p>}
    <p>Sent means SMTP accepted the email, not confirmed mailbox delivery. Uncertain sends are held for administrator investigation to avoid duplicates.</p>
  </section>;
}
