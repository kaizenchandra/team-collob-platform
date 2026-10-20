"use client";
import {useCallback,useEffect,useRef,useState} from 'react';
function currentPermission(){return typeof Notification==='undefined'||!window.isSecureContext?'unsupported':Notification.permission;}
export function NotificationPermission(){
  const [permission,setPermission]=useState('Checking browser support'),[pending,setPending]=useState(false),[error,setError]=useState(false);
  const active=useRef(true),prompting=useRef(false);
  const refresh=useCallback(()=>{if(active.current)setPermission(currentPermission());},[]);
  useEffect(()=>{
    active.current=true;let status:PermissionStatus|undefined,disposed=false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Read the browser-owned permission snapshot on mount.
    refresh();
    const visible=()=>{if(document.visibilityState==='visible')refresh();};
    window.addEventListener('focus',refresh);document.addEventListener('visibilitychange',visible);
    if(typeof Notification!=='undefined'&&window.isSecureContext&&navigator.permissions?.query){
      void navigator.permissions.query({name:'notifications'}).then(value=>{if(disposed)return;status=value;status.addEventListener('change',refresh);refresh();}).catch(()=>{/* Focus refresh remains available without the Permissions API. */});
    }
    return()=>{disposed=true;active.current=false;window.removeEventListener('focus',refresh);document.removeEventListener('visibilitychange',visible);status?.removeEventListener('change',refresh);};
  },[refresh]);
  async function request(){
    if(prompting.current||currentPermission()==='unsupported')return;
    prompting.current=true;setPending(true);setError(false);
    try{await Notification.requestPermission();if(active.current)refresh();}
    catch{if(active.current){refresh();setError(true);}}
    finally{prompting.current=false;if(active.current)setPending(false);}
  }
  return <section aria-label="Browser notification permission"><p role="status">Browser permission: {permission}. Permission and saved preferences are both required.</p>
    <button type="button" className="secondary" disabled={pending||permission==='unsupported'||permission==='Checking browser support'} onClick={()=>void request()}>Allow browser notifications</button>
    {pending&&<p role="status">Waiting for the browser permission response…</p>}
    {permission==='denied'&&<p>Browser notifications are blocked. Change this site’s permission in your browser, then return here.</p>}
    {permission==='unsupported'&&<p>Browser notifications are unavailable here. Use Activity to check your messages.</p>}
    {error&&<p role="alert">Permission could not be requested. Check browser settings or use Activity. Your saved preferences are unchanged.</p>}
  </section>;
}
