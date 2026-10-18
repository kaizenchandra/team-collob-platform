"use client";
import {useEffect,useRef,useState} from 'react';
import {z} from 'zod';
import {api,messageView} from '@/lib/contracts';
import {messageLink,type MessageLinkTarget} from '@/lib/message-link';
import {Modal} from './primitives';
import {MessageContent} from './message-content';
import {MessageAttachments} from './attachments';
const snapshot=z.object({channel:z.object({id:z.uuid(),name:z.string()}),message:messageView.omit({user_id:true,seq:true,deleted:true,reactions:true,saved:true})});
export function LinkedMessage({target,onClose,onConversation}:{target:MessageLinkTarget;onClose:()=>void;onConversation:()=>Promise<boolean>}){
  const mounted=useRef(true);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  const [data,setData]=useState<z.infer<typeof snapshot>|null>(null),[error,setError]=useState(''),[notice,setNotice]=useState(''),[navigationError,setNavigationError]=useState(''),[busy,setBusy]=useState(false),[attempt,setAttempt]=useState(0);
  useEffect(()=>{
    let active=true,pending=false;const controller=new AbortController();
    async function refresh(){
      if(pending)return;pending=true;
      try{
        const result=snapshot.parse(await api(`/organizations/${target.org}/channels/${target.channel}/messages/${target.id}`,'GET',undefined,AbortSignal.any([controller.signal,AbortSignal.timeout(8000)])));
        if(result.channel.id!==target.channel||result.message.id!==target.id)throw new Error('Message response did not match this link');
        if(active){setData(result);setError('');}
      }catch(e){if(active){setData(null);setNotice('');setError(e instanceof Error?e.message:'Message unavailable');}}
      finally{pending=false;}
    }
    void refresh();const timer=setInterval(()=>void refresh(),5000);
    return()=>{active=false;controller.abort();clearInterval(timer);};
  },[target.org,target.channel,target.id,attempt]);
  return <Modal title="Linked message" onClose={onClose}><div className="modal-body linked-message">
    <p>This view shows the selected message. Open the conversation for its surrounding discussion.</p>
    {!data&&!error&&<p role="status">Loading message…</p>}
    {error&&<div role="alert"><p>{error}</p><button className="secondary" onClick={()=>{setError('');setAttempt(value=>value+1);}}>Retry message</button></div>}
    {notice&&<p role="status">{notice}</p>}
    {navigationError&&<p role="alert">{navigationError}</p>}
    {data&&<><article aria-label="Selected message"><h3>{data.message.name} · #{data.channel.name}</h3>
      <p><time dateTime={data.message.created_at}>{new Date(data.message.created_at).toLocaleString()}</time>{data.message.edited_at?' · Edited':''}{data.message.parent_id?' · Reply':''}</p>
      <MessageContent body={data.message.body} format={data.message.format} mentions={data.message.mentions}/>
      <MessageAttachments channelId={target.channel} attachments={data.message.attachments}/>
    </article><div className="search-actions">
      <button className="secondary" disabled={busy} onClick={async()=>{try{await navigator.clipboard.writeText(messageLink(window.location.origin,target));if(mounted.current)setNotice('Message link copied.');}catch{if(mounted.current)setNotice('Clipboard unavailable. Try copying the link again.');}}}>Copy message link</button>
      <button className="secondary" disabled={busy} onClick={async()=>{setBusy(true);setNavigationError('');try{const opened=await onConversation();if(mounted.current){if(opened)onClose();else setNavigationError('Conversation could not be opened. Your draft was kept.');}}catch{if(mounted.current)setNavigationError('Conversation could not be opened. Try again.');}finally{if(mounted.current)setBusy(false);}}}>Open conversation</button>
    </div></>}
  </div></Modal>;
}
