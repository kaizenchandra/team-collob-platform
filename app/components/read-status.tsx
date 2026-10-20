"use client";
import {useEffect,useMemo,useState} from 'react';
import {Check,CheckCheck} from 'lucide-react';
import {api,ApiError} from '@/lib/contracts';
import {messageSequence,readersAt,receiptSnapshot,type SharedReceipt} from '@/lib/message-sequence';

export function useReadReceipts(user:string,org:string,channel:string,enabled:boolean,onError:(error:unknown)=>void){
  const key=`${user}:${org}:${channel}`;
  const [attempt,setAttempt]=useState(0);
  const scope=useMemo(()=>({key,enabled,attempt}),[key,enabled,attempt]);
  const [state,setState]=useState<{scope:typeof scope|null;receipts:SharedReceipt[]|null;error:string}>({scope:null,receipts:null,error:''});
  useEffect(()=>{
    if(!enabled||!user||!org||!channel)return;
    let active=true,pending=false,failed=false;const controller=new AbortController();
    // A retry withdraws the previous failed snapshot while its replacement loads.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState({scope,receipts:null,error:''});
    async function refresh(){
      if(pending||failed)return;pending=true;
      try{
        const data=receiptSnapshot.parse(await api(`/channels/${channel}/receipts`,'GET',undefined,AbortSignal.any([controller.signal,AbortSignal.timeout(8000)])));
        if(active)setState({scope,receipts:data.receipts,error:''});
      }catch(e){if(active){failed=true;setState({scope,receipts:null,error:'Read status unavailable. Retry to check shared read positions.'});if(e instanceof ApiError&&e.status===401)onError(e);}}
      finally{pending=false;}
    }
    void refresh();const timer=setInterval(()=>void refresh(),5000);
    return()=>{active=false;controller.abort();clearInterval(timer);};
  },[scope,user,org,channel,enabled,onError]);
  const current=enabled&&state.scope===scope?state:null;
  return {receipts:current?.receipts??null,error:current?.error??'',retry:()=>setAttempt(value=>value+1)};
}

export function MessageReadStatus({sequence,authorId,receipts,error}:{sequence:string;authorId:string;receipts:SharedReceipt[]|null;error:string}){
  const valid=messageSequence.safeParse(sequence).success;
  const names=valid&&receipts?readersAt(receipts,sequence,authorId):[];
  const label=!valid||error?'Sent · read status unavailable':receipts===null?'Sent · checking read status':names.length?'Read':'Sent';
  const detail=names.length?`Read by ${names.join(', ')}`:label==='Sent'?'Persisted on server. No shared read position returned at or beyond this message.':label;
  return <span className="receipt" role="group" aria-label={detail} title={detail}>{names.length?<CheckCheck size={14} aria-hidden="true"/>:<Check size={14} aria-hidden="true"/>}{label}</span>;
}
