"use client";
import {useCallback,useEffect,useRef,useState} from 'react';
import {z} from 'zod';
import {messageLink} from '@/lib/message-link';
import {NotificationPermission} from './notification-permission';
import {DigestHistory} from './digest-history';
import {api} from '@/lib/contracts';
const preferenceFields=z.object({browser_replies_enabled:z.boolean(),browser_enabled:z.boolean(),quiet_enabled:z.boolean(),quiet_start:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),quiet_end:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),digest_enabled:z.boolean()});
const preferencesSnapshot=preferenceFields.extend({email_provider:z.enum(['unconfigured','local-capture','configured'])});
type Preferences=z.infer<typeof preferencesSnapshot>;
const editable=['browser_enabled','browser_replies_enabled','digest_enabled','quiet_enabled','quiet_start','quiet_end'] as const;
export function NotificationSettings(){
  const [preferences,setPreferences]=useState<Preferences|null>(null),[baseline,setBaseline]=useState<Preferences|null>(null),[unconfirmed,setUnconfirmed]=useState<string[]>([]),[error,setError]=useState(''),[saved,setSaved]=useState(false),[loading,setLoading]=useState(true),[saving,setSaving]=useState(false);
  const active=useRef(true),read=useRef<AbortController|null>(null),write=useRef<AbortController|null>(null),writing=useRef(false);
  const reload=useCallback(async()=>{
    if(writing.current)return;
    read.current?.abort();const controller=new AbortController();read.current=controller;setLoading(true);setPreferences(null);setSaved(false);setError('');
    try{const p=preferencesSnapshot.parse(await api('/notification-settings','GET',undefined,AbortSignal.any([controller.signal,AbortSignal.timeout(8000)])));if(active.current&&!controller.signal.aborted){setPreferences(p);setBaseline(p);setUnconfirmed([]);}}
    catch{if(active.current&&!controller.signal.aborted)setError('Notification settings are unavailable. Reload to retry.');}
    finally{if(read.current===controller){read.current=null;if(active.current)setLoading(false);}}
  },[]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- Hydrate the actor-keyed remote preferences.
  useEffect(()=>{active.current=true;void reload();return()=>{active.current=false;read.current?.abort();write.current?.abort();};},[reload]);
  const change=(patch:Partial<Preferences>)=>{if(writing.current)return;setPreferences(p=>p?{...p,...patch}:p);setSaved(false);setError('');};
  const changes=preferences&&baseline?Object.fromEntries(editable.filter(key=>preferences[key]!==baseline[key]||unconfirmed.includes(key)).map(key=>[key,preferences[key]])):{};
  const changed=Object.keys(changes).length>0;
  const save=async()=>{
    if(writing.current||!preferences||!changed)return;
    writing.current=true;setSaving(true);setSaved(false);setError('');read.current?.abort();const controller=new AbortController();write.current=controller;
    try{z.object({ok:z.literal(true)}).parse(await api('/notification-settings','PATCH',preferenceFields.partial().parse(changes),AbortSignal.any([controller.signal,AbortSignal.timeout(8000)])));if(active.current&&!controller.signal.aborted){setBaseline(preferences);setUnconfirmed([]);setSaved(true);}}
    catch{if(active.current&&!controller.signal.aborted){setUnconfirmed(previous=>[...new Set([...previous,...Object.keys(changes)])]);setError('Save could not be confirmed. Your choices were kept. Reload notification settings to check the server before trying again.');}}
    finally{if(write.current===controller){write.current=null;writing.current=false;if(active.current)setSaving(false);}}
  };
  return <section className="card settings-form" aria-label="Notification settings"><h2>Browser message alerts</h2>
    <p>Alerts identify the workspace and channel, without message text. Clicking an alert opens its exact current message source. Keep this workspace open. Delivery while closed, mobile push and invitation/call alerts are not available.</p>
    <NotificationPermission/>
    <p>Only edited fields are saved. Reload replaces unsaved choices and shows changes from other sessions.</p><button type="button" className="secondary" disabled={saving} onClick={()=>void reload()}>Reload notification settings</button>
    {error&&<p role="alert">{error}</p>}
    {loading&&<p role="status">Loading notification settings…</p>}
    {preferences&&unconfirmed.length>0&&<p role="status">A previous save is unconfirmed. Saving again sends your current choices for the affected fields, including reversions. Reload checks server settings.</p>}
    {preferences&&<form onSubmit={e=>{e.preventDefault();void save();}}><fieldset disabled={saving} className="notification-fields">
      <label className="check-label"><input type="checkbox" checked={preferences.browser_enabled} onChange={e=>change({browser_enabled:e.target.checked})}/>Enable browser mention alerts</label>
      <label className="check-label"><input type="checkbox" checked={preferences.browser_replies_enabled} onChange={e=>change({browser_replies_enabled:e.target.checked})}/>Enable browser reply alerts</label>
      <p>Reply alerts cover other people replying directly to your messages. Each category starts with new messages after you enable it.</p>
      <h3>Missed-activity email digests</h3>
      <p>Email provider: {preferences.email_provider}. {preferences.email_provider==='local-capture'?'Local capture is viewable at localhost:5185. No external delivery.':'Ask your administrator about SMTP delivery configuration.'}</p>
      <label className="check-label"><input type="checkbox" checked={preferences.digest_enabled} onChange={e=>change({digest_enabled:e.target.checked})}/>Enable hourly email digests</label>
      <p>Sent to your account email. Includes authorized private activity counts without message text or private channel names. Each workspace sends at most once per UTC hour; quiet hours delay sending.</p>
      <label className="check-label"><input type="checkbox" checked={preferences.quiet_enabled} onChange={e=>change({quiet_enabled:e.target.checked})}/>Enable quiet hours</label>
      <label>Quiet hours start<input type="time" required value={preferences.quiet_start} onChange={e=>change({quiet_start:e.target.value})}/></label>
      <label>Quiet hours end<input type="time" required value={preferences.quiet_end} onChange={e=>change({quiet_end:e.target.value})}/></label>
      <p>Uses your saved profile timezone. Equal start and end means quiet all day. Quiet hours and muted conversations suppress alerts; Activity remains available. Unread mentions and replies from the last 24 hours can appear after quiet hours.</p>
      <button className="primary" disabled={!changed}>Save notification settings</button></fieldset>{saving&&<p role="status">Saving notification settings…</p>}{saved&&<p role="status">Notification settings saved.</p>}
    </form>}
    <DigestHistory/>
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
