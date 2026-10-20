"use client";
import {useCallback,useEffect,useRef,useState} from 'react';
import {z} from 'zod';
import {Hand,MessageSquare,Send} from 'lucide-react';
import {pendingCallChat,saveCallChat,acknowledgeCallChat} from '@/lib/pending-call-chat';
import {api,ApiError} from '@/lib/contracts';
import {mediaChatSchema,type MediaGrant,type MediaState} from '@/lib/media-contracts';

export function CallCollaboration({base,userId,grant,state,onRefresh,embedded=false,open:controlledOpen,visible=true,onUnreadChange}:{embedded?:boolean;open?:boolean;visible?:boolean;onUnreadChange?:(count:number)=>void;base:string;userId:string;grant:MediaGrant;state:MediaState|null;onRefresh:()=>Promise<void>}){
  const [localOpen,setOpen]=useState(true),[older,setOlder]=useState<z.infer<typeof mediaChatSchema>['messages']>([]),[nextCursor,setNextCursor]=useState<string|null>(null),[unread,setUnread]=useState(0),[messages,setMessages]=useState<z.infer<typeof mediaChatSchema>['messages']>([]),[text,setText]=useState(''),[error,setError]=useState(''),[readError,setReadError]=useState(''),[busy,setBusy]=useState(false),[handBusy,setHandBusy]=useState(false),[pending,setPending]=useState<{clientId:string;body:string}|null>(()=>{try{return pendingCallChat(sessionStorage,userId,base.split('/').at(-1)!,grant.roomId);}catch{return null;}});
  const open=controlledOpen??localOpen;
  useEffect(()=>{onUnreadChange?.(unread);},[unread,onUnreadChange]);
  const following=useRef(true);
  const sending=useRef(false),active=useRef(true),olderLoaded=useRef(false),controller=useRef<AbortController|null>(null),composing=useRef(false),bottom=useRef<HTMLDivElement|null>(null);
  const endpoint=`${base}/connections/${grant.grantId}`,roster=state?.participants.filter(p=>p.room_id===grant.roomId)??[],raised=roster.filter(p=>p.hand_raised_at).sort((a,b)=>Number(BigInt(a.hand_order??'0')-BigInt(b.hand_order??'0'))),ownRaised=!!roster.find(p=>p.id===grant.grantId)?.hand_raised_at;
  const read=useCallback(async(signal:AbortSignal)=>{const data=mediaChatSchema.parse(await api(`${endpoint}/chat`,'GET',undefined,signal));if(data.roomId!==grant.roomId)throw new Error('Room changed');if(active.current&&!signal.aborted){setMessages(data.messages);setUnread(data.unread);if(!olderLoaded.current)setNextCursor(data.nextCursor);setReadError('');}},[endpoint,grant.roomId]);
  useEffect(()=>{active.current=true;const lifetime=new AbortController();controller.current=lifetime;let reading=false;const tick=async()=>{if(reading)return;reading=true;try{await read(AbortSignal.any([lifetime.signal,AbortSignal.timeout(5000)]));}catch{if(!lifetime.signal.aborted){setMessages([]);setReadError('Call chat unavailable. Check your connection or rejoin.');}}finally{reading=false;}};void tick();const refresh=()=>void tick();window.addEventListener('meeting-change',refresh);const timer=setInterval(refresh,5000);return()=>{active.current=false;lifetime.abort();clearInterval(timer);window.removeEventListener('meeting-change',refresh);};},[read]);
  // Follow new chat messages only while the user is already near the bottom.
  useEffect(()=>{const e=bottom.current?.closest('.call-chat-messages');if(e&&following.current&&visible&&open)e.scrollTop=e.scrollHeight;},[messages,visible,open]);
  useEffect(()=>{if(!visible||!open||!messages.length||!following.current)return;void api(`${endpoint}/read-chat`,'POST',{seq:messages[messages.length-1].seq},AbortSignal.timeout(5000)).then(()=>setUnread(0)).catch(()=>{});},[open,messages,endpoint,visible]);
  const displayed=Array.from(new Map([...older,...messages].map(m=>[m.id,m])).values()).sort((a,b)=>BigInt(a.seq)<BigInt(b.seq)?-1:BigInt(a.seq)>BigInt(b.seq)?1:0);
  async function send(){if(sending.current||!text.trim()&&!pending)return;sending.current=true;setBusy(true);setError('');const intent=pending??{clientId:crypto.randomUUID(),body:text.trim()};setPending(intent);
    try{saveCallChat(sessionStorage,{...intent,user:userId,call:base.split('/').at(-1)!,room:grant.roomId,createdAt:Date.now()});z.object({id:z.uuid()}).parse(await api(`${endpoint}/chat`,'POST',{...intent,roomId:grant.roomId},AbortSignal.any([controller.current!.signal,AbortSignal.timeout(8000)])));if(!active.current)return;acknowledgeCallChat(sessionStorage,intent.clientId);setPending(null);setText('');try{await read(AbortSignal.any([controller.current!.signal,AbortSignal.timeout(5000)]));}catch{if(active.current){setMessages([]);setReadError('Message sent; chat refresh is unavailable.');}}}
    catch(e){if(active.current){setError(e instanceof ApiError?e.message:'Message acknowledgement unavailable. Retry the same message.');if(e instanceof ApiError&&[400,403,404,409,429].includes(e.status)){acknowledgeCallChat(sessionStorage,intent.clientId);setPending(null);}}}
    finally{sending.current=false;if(active.current)setBusy(false);}
  }
  async function hand(){setHandBusy(true);setError('');try{await api(`${endpoint}/hand`,'POST',{raised:!ownRaised},AbortSignal.any([controller.current!.signal,AbortSignal.timeout(5000)]));if(active.current)await onRefresh();}catch{if(active.current)setError('Hand status could not be updated. Refresh or rejoin.');}finally{if(active.current)setHandBusy(false);}}
  return <section className="call-collaboration" aria-label="Call collaboration">
    {!embedded&&<div className="media-controls"><button className="secondary" aria-pressed={ownRaised} disabled={handBusy||!state} onClick={()=>void hand()}><Hand size={17}/>{ownRaised?'Lower hand':'Raise hand'}</button><button className="secondary" aria-expanded={open} onClick={()=>setOpen(v=>!v)}><MessageSquare size={17}/>{open?'Hide call chat':`Show call chat (${unread} unread)`}</button><span>{roster.length} in this room</span></div>}
    {!embedded&&<section aria-label="Raised hands"><h3>Raised hands</h3>{raised.length?<ol>{raised.map(p=><li key={p.id}>{p.name} · Hand raised</li>)}</ol>:<p>{state?'No hands raised':'Hand status unavailable'}</p>}</section>}
    {error&&<p role="alert">{error}</p>}
    <div hidden={!open} className="call-chat"><h3>Call chat</h3><p>Visible to participants in this room. Retained message history; load earlier messages below. Call chat is separate from conversation posts.</p>
      {readError&&<p role="alert">{readError}</p>}
      {nextCursor&&<button className="secondary" onClick={()=>void api(`${endpoint}/chat?before=${nextCursor}`).then(r=>{const page=mediaChatSchema.parse(r);if(page.roomId!==grant.roomId)return;olderLoaded.current=true;setOlder(v=>[...page.messages,...v]);setNextCursor(page.nextCursor);}).catch(()=>setReadError('Older messages unavailable'))}>Earlier call messages</button>}
      <ol aria-label="Call messages" className="call-chat-messages" onScroll={e=>{const list=e.currentTarget;following.current=list.scrollHeight-list.scrollTop-list.clientHeight<100;}} aria-live="polite" aria-relevant="additions">{displayed.map(m=><li key={m.id}><strong>{m.name}</strong><span className="message-delivery"> Sent</span><time dateTime={m.created_at}>{new Date(m.created_at).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</time><p>{m.body}</p></li>)}<li className="call-chat-bottom" aria-hidden="true"><div ref={bottom}/></li></ol>
      {pending&&<p role="status">{busy?'Sending message…':'Message not confirmed. Retry preserves its identity.'}</p>}
      <form onSubmit={e=>{e.preventDefault();if(!composing.current)void send();}}><label>Call message<textarea value={pending?.body??text} maxLength={4000} rows={3} disabled={busy||!!pending} onCompositionStart={()=>{composing.current=true;}} onCompositionEnd={()=>{composing.current=false;}} onChange={e=>setText(e.target.value)}/></label><button className="primary" disabled={busy||!text.trim()&&!pending} type="submit"><Send size={16}/>{busy?'Sending…':pending?'Retry call message':'Send call message'}</button></form>
    </div>
  </section>;
}
