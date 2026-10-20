"use client";
import {useCallback,useEffect,useState} from 'react';
import {Reply,X} from 'lucide-react';
import {z} from 'zod';
import {api,ApiError} from '@/lib/contracts';
import {draftReply,setDraftReply,clearDraftReplies} from '@/lib/draft-replies';
const snapshot=z.object({channel:z.object({id:z.uuid()}),message:z.object({id:z.uuid(),name:z.string(),body:z.string().max(10000)})});
type Source=z.infer<typeof snapshot>['message'];
export function useReplyDraft(userId:string,orgId:string,channelId:string){
  const key=`${userId}:${orgId}:${channelId}`;
  const [saved,setSaved]=useState<{key:string;id:string|null;error:string}>({key:'',id:null,error:''});
  const [remote,setRemote]=useState<{key:string;message:Source|null;error:string}>({key:'',message:null,error:''});
  const [attempt,setAttempt]=useState(0);
  const reload=useCallback(()=>{
    if(!userId||!orgId||!channelId)return;
    setRemote({key:'',message:null,error:''});
    try{setSaved({key:`${userId}:${orgId}:${channelId}`,id:draftReply(window.sessionStorage,{userId,orgId,channelId}),error:''});}
    catch(e){setSaved({key:`${userId}:${orgId}:${channelId}`,id:null,error:e instanceof Error?e.message:'Reply selections unavailable. Clear saved reply selections to continue.'});}
  },[userId,orgId,channelId]);
  useEffect(()=>{
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Restore the actor/conversation-scoped local reply selection.
    reload();
  },[reload]);
  const current=saved.key===key,id=current?saved.id:null,target=`${key}:${id??''}`;
  useEffect(()=>{
    if(!id)return;let active=true,pending=false;const controller=new AbortController();
    async function refresh(){
      if(pending)return;pending=true;
      try{
        const result=snapshot.parse(await api(`/organizations/${orgId}/channels/${channelId}/messages/${id}`,'GET',undefined,AbortSignal.any([controller.signal,AbortSignal.timeout(8000)])));
        if(result.channel.id!==channelId||result.message.id!==id)throw new Error('Reply target did not match the selection');
        if(active&&!controller.signal.aborted)setRemote({key:target,message:result.message,error:''});
      }catch(e){if(active&&!controller.signal.aborted)setRemote({key:target,message:null,error:e instanceof ApiError?e.message:'Reply target could not be loaded. Retry or cancel this reply.'});}
      finally{pending=false;}
    }
    void refresh();const timer=setInterval(()=>void refresh(),5000);return()=>{active=false;controller.abort();clearInterval(timer);};
  },[id,orgId,channelId,target,attempt]);
  const source=remote.key===target?remote:null;
  return {
    id,message:source?.message??null,error:source?.error??'',cacheError:current?saved.error:'',cacheReady:current&&!saved.error,
    ready:current&&!saved.error&&(!id||!!source?.message&&!source.error),loading:!!id&&!source?.message&&!source?.error,
    reload,invalidate(error:unknown){setSaved({key,id:null,error:error instanceof Error?error.message:'Reply selections unavailable. Clear saved reply selections to continue.'});},
    select(messageId:string|null){setDraftReply(window.sessionStorage,{userId,orgId,channelId},messageId);setRemote({key:'',message:null,error:''});setSaved({key,id:messageId,error:''});},
    retry(){setRemote({key:target,message:null,error:''});setAttempt(value=>value+1);},
    clear(){clearDraftReplies(window.sessionStorage);setSaved({key,id:null,error:''});},
  };
}
export function ReplyDraft({draft,disabled,cancel,clear}:{draft:ReturnType<typeof useReplyDraft>;disabled:boolean;cancel:()=>void;clear:()=>void}){
  if(draft.cacheError)return <div role="alert"><p>{draft.cacheError}</p><p>Clearing removes saved reply targets in this tab. Text, file selections and unconfirmed messages are kept.</p><button type="button" className="secondary" disabled={disabled} onClick={clear}>Clear saved reply selections</button></div>;
  if(!draft.id)return null;
  return <section aria-label="Reply draft" className="reply-draft"><div className="replying"><Reply size={14}/><span>{draft.message?`Replying to ${draft.message.name}: ${draft.message.body.slice(0,65)}`:'Reply target selected'}</span><button type="button" disabled={disabled} aria-label="Cancel reply" onClick={cancel}><X size={15}/></button></div>
    <p>Reply target saved in this browser tab. Current access is checked before sending.</p>
    {draft.loading&&<p role="status">Loading reply target…</p>}
    {draft.error&&<div role="alert"><p>{draft.error}</p><button className="secondary" type="button" onClick={draft.retry}>Retry reply target</button></div>}
  </section>;
}
