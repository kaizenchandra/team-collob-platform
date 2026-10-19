"use client";
import {useEffect,useState} from 'react';
import {z} from 'zod';
import {messageLink} from '@/lib/message-link';
import {api} from '@/lib/contracts';
type Preferences={browser_replies_enabled:boolean;browser_enabled:boolean;quiet_enabled:boolean;quiet_start:string;quiet_end:string;digest_enabled:boolean;email_provider:string};
export function NotificationSettings(){
  const [historyError,setHistoryError]=useState(false);
  const [jobs,setJobs]=useState<{id:string;state:string;attempts:number}[]>([]);
  const [preferences,setPreferences]=useState<Preferences|null>(null),[error,setError]=useState(''),[saved,setSaved]=useState(false),[permission,setPermission]=useState('Checking browser support'),[attempt,setAttempt]=useState(0);
  useEffect(()=>{
    let active=true;
    void api<Preferences>('/notification-settings').then(p=>{if(active){setPreferences(p);setError('');setPermission(typeof Notification==='undefined'||!window.isSecureContext?'unsupported':Notification.permission);}}).catch(e=>{if(active)setError(e.message);});
    return()=>{active=false;};
  },[attempt]);
  useEffect(()=>{
    let active=true,pending=false;
    const refresh=async()=>{if(pending)return;pending=true;try{const r=await api<{jobs:typeof jobs}>('/digest-jobs');if(active){setJobs(r.jobs);setHistoryError(false); }}catch{if(active){setJobs([]);setHistoryError(true);}}finally{pending=false;}};
    void refresh();const timer=setInterval(()=>void refresh(),5000);return()=>{active=false;clearInterval(timer);};
  },[]);
  return <section className="card settings-form"><h2>Browser message alerts</h2>
    <p>Alerts identify the workspace and channel, without message text. Clicking an alert opens its exact current message source. Keep this workspace open. Delivery while closed, mobile push and invitation/call alerts are not available.</p>
    <p>Browser permission: {permission}. Permission and saved preferences are both required.</p>
    <button type="button" className="secondary" disabled={permission==='unsupported'} onClick={async()=>{try{setPermission(await Notification.requestPermission());}catch{setError('Permission is unavailable. Check browser settings or use Activity.');}}}>Allow browser notifications</button>
    {error && <div role="alert"><p>{error}</p><button type="button" className="secondary" onClick={()=>setAttempt(n=>n+1)}>Reload notification settings</button></div>}
    {!preferences && !error && <p role="status">Loading notification settings…</p>}
    {preferences && <form onSubmit={async e=>{e.preventDefault();setSaved(false);try{await api('/notification-settings','PUT',preferences);setSaved(true);setError('');}catch(e){setError(e instanceof Error?e.message:'Settings could not be saved');}}}>
      <label className="check-label"><input type="checkbox" checked={preferences.browser_enabled} onChange={e=>setPreferences({...preferences,browser_enabled:e.target.checked})}/>Enable browser mention alerts</label>
      <label className="check-label"><input type="checkbox" checked={preferences.browser_replies_enabled} onChange={e=>setPreferences({...preferences,browser_replies_enabled:e.target.checked})}/>Enable browser reply alerts</label>
      <p>Reply alerts cover other people replying directly to your messages. Each category starts with new messages after you enable it.</p>
      <h3>Missed-activity email digests</h3>
      <p>Email provider: {preferences.email_provider}. {preferences.email_provider==='local-capture'?'Local capture is viewable at localhost:5185. No external delivery.':'Ask your administrator about SMTP delivery configuration.'}</p>
      <label className="check-label"><input type="checkbox" checked={preferences.digest_enabled} onChange={e=>setPreferences({...preferences,digest_enabled:e.target.checked})}/>Enable hourly email digests</label>
      <p>Sent to your account email. Includes authorized private activity counts without message text or private channel names. Each workspace sends at most once per UTC hour; quiet hours delay sending.</p>
      <label className="check-label"><input type="checkbox" checked={preferences.quiet_enabled} onChange={e=>setPreferences({...preferences,quiet_enabled:e.target.checked})}/>Enable quiet hours</label>
      <label>Quiet hours start<input type="time" required value={preferences.quiet_start} onChange={e=>setPreferences({...preferences,quiet_start:e.target.value})}/></label>
      <label>Quiet hours end<input type="time" required value={preferences.quiet_end} onChange={e=>setPreferences({...preferences,quiet_end:e.target.value})}/></label>
      <p>Uses your saved profile timezone. Equal start and end means quiet all day. Quiet hours and muted conversations suppress alerts; Activity remains available. Unread mentions and replies from the last 24 hours can appear after quiet hours.</p>
      <button className="primary">Save notification settings</button>{saved&&<p role="status">Notification settings saved.</p>}
      <h3>Recent digest delivery</h3>
      {historyError && <p role="alert">Digest history is unavailable. Retrying automatically.</p>}
      {!historyError && (jobs.length?jobs.map(j=><p key={j.id}>Digest {j.id.slice(0,8)}: {j.state} · attempts {j.attempts}</p>):<p>No digest jobs yet.</p>)}
      <p>Sent means SMTP accepted the email, not confirmed mailbox delivery. Uncertain sends are held for administrator investigation to avoid duplicates.</p>
    </form>}
  </section>;
}
const claims=z.object({items:z.array(z.object({id:z.uuid(),channel_id:z.uuid(),channel_name:z.string(),organization_name:z.string(),kind:z.enum(['mention','reply']).default('mention')})).max(10)});
export function BrowserMentionAlerts({org,userId}:{org:string;userId:string}){
  const [problem,setProblem]=useState('');
  useEffect(()=>{
    let active=true,pending=false,failed=false;
    const open=new Set<Notification>(),timers=new Set<ReturnType<typeof setTimeout>>(),controller=new AbortController();
    const poll=async()=>{
      if(pending||failed||typeof Notification==='undefined'||Notification.permission!=='granted')return;
      pending=true;
      try{
        const result=claims.parse(await api(`/organizations/${org}/notification-claims`,'POST',{},AbortSignal.any([controller.signal,AbortSignal.timeout(8000)])));
        if(!active)return;
        setProblem('');
        for(const item of result.items){
          const href=messageLink(window.location.origin,{org,channel:item.channel_id,id:item.id});
          let notification:Notification;
          try{notification=new Notification(item.organization_name,{body:`New ${item.kind==='reply'?'reply':'mention'} in ${item.channel_name}`,tag:`${org}:${item.id}`});}
          catch{failed=true;setProblem('This browser could not display notifications. Use Activity; mobile push is not available.');break;}
          open.add(notification);
          let activated=false;
          notification.onclick=()=>{if(!active||activated)return;activated=true;notification.onclick=null;notification.close();open.delete(notification);window.open(href,'_blank','noopener,noreferrer');};
          const timer=setTimeout(()=>{notification.onclick=null;notification.close();open.delete(notification);timers.delete(timer);},15000);timers.add(timer);
        }
      }catch{if(active)setProblem('Browser alerts are temporarily unavailable. Your messages remain in Activity.');}
      finally{pending=false;}
    };
    void poll();const interval=setInterval(()=>void poll(),10000);
    return()=>{active=false;controller.abort();clearInterval(interval);for(const timer of timers)clearTimeout(timer);for(const notification of open){notification.onclick=null;notification.close();}};
  },[org,userId]);
  return problem?<div className="notice notification-status" role="status">{problem}</div>:null;
}
