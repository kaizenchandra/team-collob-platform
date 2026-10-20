"use client";
import {useEffect,useState} from 'react';
import {z} from 'zod';
import {api,messageView} from '@/lib/contracts';
import {type MessageLinkTarget} from '@/lib/message-link';
import {MessageContent} from './message-content';
import {MessageAttachments} from './attachments';
const snapshot=z.object({channel:z.object({id:z.uuid(),name:z.string()}),message:messageView.omit({user_id:true,seq:true,deleted:true,reactions:true})});
export function ReplyContext({target,onOpen,disabled=false}:{target:MessageLinkTarget;onOpen:(id:string)=>void;disabled?:boolean}) {
  const [data,setData]=useState<z.infer<typeof snapshot>|null>(null),[error,setError]=useState(''),[attempt,setAttempt]=useState(0);
  useEffect(()=>{
    let active=true,pending=false;const controller=new AbortController();
    async function refresh() {
      if(pending)return;pending=true;
      try {
        const result=snapshot.parse(await api(`/organizations/${target.org}/channels/${target.channel}/messages/${target.id}`,'GET',undefined,AbortSignal.any([controller.signal,AbortSignal.timeout(8000)])));
        if(result.channel.id!==target.channel||result.message.id!==target.id)throw new Error('Reply context response did not match this message');
        if(active){setData(result);setError('');}
      } catch(e) {if(active){setData(null);setError(e instanceof Error?e.message:'Replied-to message unavailable');}}
      finally {pending=false;}
    }
    void refresh();const timer=setInterval(()=>void refresh(),5000);
    return()=>{active=false;controller.abort();clearInterval(timer);};
  },[target.org,target.channel,target.id,attempt]);
  return <section aria-label="Replied-to message" className="reply-context"><h4>Replied-to message</h4>
    {!data&&!error&&<p role="status">Loading replied-to message…</p>}
    {error&&<div role="alert"><p>{error}</p><button className="secondary" onClick={()=>{setError('');setAttempt(value=>value+1);}}>Retry replied-to message</button></div>}
    {data&&<article aria-label="Reply target"><h4>{data.message.name} · #{data.channel.name}</h4>
      <p><time dateTime={data.message.created_at}>{new Date(data.message.created_at).toLocaleString()}</time>{data.message.edited_at?' · Edited':''}</p>
      <MessageContent body={data.message.body} format={data.message.format} mentions={data.message.mentions}/>
      <MessageAttachments channelId={target.channel} attachments={data.message.attachments}/>
      <p><button className="secondary" disabled={disabled} onClick={()=>onOpen(data.message.id)}>Open replied-to message</button></p>
    </article>}
  </section>;
}
