"use client";
import {useEffect,useRef,useState} from 'react';
import {z} from 'zod';
import {ApiError,api,messageView} from '@/lib/contracts';
import {messageLink,type MessageLinkTarget} from '@/lib/message-link';
import {DirectReplies} from './direct-replies';
import {ReplyContext} from './reply-context';
import {Modal} from './primitives';
import {MessageContent} from './message-content';
import {MessageAttachments} from './attachments';
const acknowledgement=z.object({ok:z.literal(true)});
const snapshot=z.object({channel:z.object({id:z.uuid(),name:z.string()}),message:messageView.omit({user_id:true,seq:true,deleted:true,reactions:true})});
export function LinkedMessage({target,onClose,onConversation,onReply,replyDisabled,onMarkedUnread,onOpenSource,onBack}:{target:MessageLinkTarget;onClose:()=>void;onConversation:()=>Promise<boolean>;onReply:(signal:AbortSignal)=>Promise<boolean>;replyDisabled:boolean;onMarkedUnread:()=>Promise<void>;onOpenSource:(id:string)=>void;onBack?:()=>void}){
  const mounted=useRef(true),mutation=useRef(false),epoch=useRef(0),copying=useRef(false),readGeneration=useRef(0),write=useRef<AbortController|null>(null),checkingSave=useRef(false);
  const [copyBusy,setCopyBusy]=useState(false),[saveUnconfirmed,setSaveUnconfirmed]=useState(false);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;write.current?.abort();};},[]);
  const [data,setData]=useState<z.infer<typeof snapshot>|null>(null),[error,setError]=useState(''),[notice,setNotice]=useState(''),[navigationError,setNavigationError]=useState(''),[saveError,setSaveError]=useState(''),[unreadError,setUnreadError]=useState(''),[showParent,setShowParent]=useState(false),[showReplies,setShowReplies]=useState(false),[badgeError,setBadgeError]=useState(false),[busy,setBusy]=useState(false),[attempt,setAttempt]=useState(0);
  useEffect(()=>{
    let active=true,pending=false;const controller=new AbortController();
    async function refresh(){
      if(pending||mutation.current)return;pending=true;const version=epoch.current;
      try{
        const result=snapshot.parse(await api(`/organizations/${target.org}/channels/${target.channel}/messages/${target.id}`,'GET',undefined,AbortSignal.any([controller.signal,AbortSignal.timeout(8000)])));
        if(result.channel.id!==target.channel||result.message.id!==target.id)throw new Error('Message response did not match this link');
        if(active&&version===epoch.current){setData(result);setError('');if(checkingSave.current){checkingSave.current=false;setSaveUnconfirmed(false);setSaveError('');setNotice('Saved status refreshed.');}}
      }catch(e){if(active&&version===epoch.current){readGeneration.current++;setData(null);setShowParent(false);setShowReplies(false);setNotice('');setError(e instanceof Error?e.message:'Message unavailable');}}
      finally{pending=false;}
    }
    void refresh();const timer=setInterval(()=>void refresh(),5000);
    return()=>{active=false;controller.abort();clearInterval(timer);};
  },[target.org,target.channel,target.id,attempt]);
  async function toggleSaved(){
    if(!data||mutation.current)return;
    const saved=!data.message.saved;
    mutation.current=true;epoch.current++;setBusy(true);setSaveError('');setSaveUnconfirmed(false);setNotice('');const controller=new AbortController();write.current=controller;
    try{
      acknowledgement.parse(await api(`/channels/${target.channel}/messages/${target.id}/save`,'POST',{saved},AbortSignal.any([controller.signal,AbortSignal.timeout(8000)])));
      if(mounted.current){setData(current=>current?{...current,message:{...current.message,saved}}:current);setNotice(saved?'Message saved.':'Message unsaved.');}
    }catch(e){if(mounted.current){
      if(e instanceof ApiError&&[401,403,404].includes(e.status)){readGeneration.current++;setData(null);setShowParent(false);setShowReplies(false);setNotice('');setError(e.message);}
      else {setSaveUnconfirmed(true);setSaveError(`${e instanceof ApiError?e.message+' ':''}Save could not be confirmed. Check saved status before trying again.`);}
    }}finally{if(write.current===controller)write.current=null;mutation.current=false;if(mounted.current)setBusy(false);}
  }
  async function refreshBadge(){
    try{await onMarkedUnread();if(mounted.current)setBadgeError(false);}
    catch{if(mounted.current)setBadgeError(true);}
  }
  async function markUnread(){
    if(!data||mutation.current)return;
    mutation.current=true;epoch.current++;setBusy(true);setUnreadError('');setNotice('');setBadgeError(false);const controller=new AbortController();write.current=controller;
    try{
      acknowledgement.parse(await api(`/channels/${target.channel}/messages/${target.id}/unread`,'POST',{},AbortSignal.any([controller.signal,AbortSignal.timeout(8000)])));
      if(mounted.current){setNotice('Marked unread from this message.');await refreshBadge();}
    }catch(e){if(mounted.current){
      if(e instanceof ApiError&&[401,403,404].includes(e.status)){readGeneration.current++;setData(null);setShowParent(false);setShowReplies(false);setNotice('');setError(e.message);}
      else setUnreadError(e instanceof ApiError?e.message:'Unread change could not be confirmed. Check the conversation before trying again.');
    }}finally{if(write.current===controller)write.current=null;mutation.current=false;if(mounted.current)setBusy(false);}
  }
  async function prepareReply(){
    if(!data||mutation.current||replyDisabled)return;
    mutation.current=true;epoch.current++;setBusy(true);setNavigationError('');setNotice('');
    const controller=new AbortController();write.current=controller;
    const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(8000)]);let validated=false;
    try{
      const current=snapshot.parse(await api(`/organizations/${target.org}/channels/${target.channel}/messages/${target.id}`,'GET',undefined,signal));
      if(current.channel.id!==target.channel||current.message.id!==target.id)throw new Error('Message response did not match this link');
      if(!mounted.current||signal.aborted)return;
      validated=true;
      const opened=await onReply(signal);
      if(mounted.current){if(opened)onClose();else setNavigationError('Reply could not be prepared. Your draft was kept.');}
    }catch(e){if(mounted.current){
      if(!validated||e instanceof ApiError&&[401,403,404].includes(e.status)){readGeneration.current++;setData(null);setShowParent(false);setShowReplies(false);setError(e instanceof ApiError?e.message:'Message could not be checked. Retry when connected.');}
      else setNavigationError(e instanceof ApiError||e instanceof Error&&e.name==='Error'?e.message:'Reply could not be prepared. Your draft was kept. Try again.');
    }}finally{if(write.current===controller)write.current=null;mutation.current=false;if(mounted.current)setBusy(false);}
  }
  return <Modal title="Linked message" onClose={onClose}><div className="modal-body linked-message">
    <p>This view shows the selected message. Open the conversation for its surrounding discussion.</p>
    {onBack&&<p><button className="secondary" disabled={busy} onClick={onBack}>Back to previous message</button></p>}
    {!data&&!error&&<p role="status">Loading message…</p>}
    {error&&<div role="alert"><p>{error}</p><button className="secondary" onClick={()=>{setError('');setAttempt(value=>value+1);}}>Retry message</button></div>}
    {notice&&<p role="status">{notice}</p>}
    {unreadError&&<p role="alert">{unreadError}</p>}
    {badgeError&&<div role="alert"><p>Unread was updated. The conversation count could not refresh.</p><button className="secondary" disabled={busy} onClick={()=>void refreshBadge()}>Refresh unread count</button></div>}
    {saveError&&<p role="alert">{saveError}</p>}
    {saveUnconfirmed&&<button className="secondary" disabled={busy||(!data&&!error)} onClick={()=>{epoch.current++;checkingSave.current=true;setData(null);setShowParent(false);setShowReplies(false);setNotice('');setError('');setAttempt(value=>value+1);}}>Check saved status</button>}
    {navigationError&&<p role="alert">{navigationError}</p>}
    {data&&<><article aria-label="Selected message"><h3>{data.message.name} · #{data.channel.name}</h3>
      <p><time dateTime={data.message.created_at}>{new Date(data.message.created_at).toLocaleString()}</time>{data.message.edited_at?' · Edited':''}{data.message.parent_id?' · Reply':''}</p>
      <MessageContent body={data.message.body} format={data.message.format} mentions={data.message.mentions}/>
      <MessageAttachments channelId={target.channel} attachments={data.message.attachments}/>
    </article>
    {data.message.parent_id&&<><p><button className="secondary" disabled={busy} aria-expanded={showParent} onClick={()=>setShowParent(value=>!value)}>{showParent?'Hide replied-to message':'View replied-to message'}</button></p>
      {showParent&&<ReplyContext key={data.message.parent_id} target={{org:target.org,channel:target.channel,id:data.message.parent_id}} onOpen={onOpenSource} disabled={busy}/>}
    </>}
    <p><button className="secondary" disabled={busy} aria-expanded={showReplies} onClick={()=>setShowReplies(value=>!value)}>{showReplies?'Hide direct replies':'View direct replies'}</button></p>
    {showReplies&&<DirectReplies key={`${target.org}:${target.channel}:${target.id}`} target={target} onOpen={onOpenSource} disabled={busy}/>}
    <div className="search-actions">
      <button className="secondary" disabled={busy||replyDisabled} onClick={()=>void prepareReply()}>Reply to this message</button>
      <button className="secondary" disabled={busy} onClick={()=>void markUnread()}>Mark unread from here</button>
      <button className="secondary" disabled={busy} onClick={()=>void toggleSaved()}>{data.message.saved?'Unsave message':'Save message'}</button>
      <button className="secondary" disabled={busy||copyBusy} onClick={async()=>{
        if(copying.current)return;copying.current=true;setCopyBusy(true);setNotice('');const generation=readGeneration.current;
        try{await navigator.clipboard.writeText(messageLink(window.location.origin,target));if(mounted.current&&generation===readGeneration.current)setNotice('Message link copied.');}
        catch{if(mounted.current&&generation===readGeneration.current)setNotice('Clipboard unavailable. Try copying the link again.');}
        finally{copying.current=false;if(mounted.current)setCopyBusy(false);}
      }}>Copy message link</button>
      <button className="secondary" disabled={busy} onClick={async()=>{setBusy(true);setNavigationError('');try{const opened=await onConversation();if(mounted.current){if(opened)onClose();else setNavigationError('Conversation could not be opened. Your draft was kept.');}}catch{if(mounted.current)setNavigationError('Conversation could not be opened. Try again.');}finally{if(mounted.current)setBusy(false);}}}>Open conversation</button>
    </div></>}
  </div></Modal>;
}
