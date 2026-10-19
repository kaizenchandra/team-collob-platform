"use client";
import {createContext,useCallback,useContext,useEffect,useId,useRef,useState,type ReactNode} from 'react';
import {z} from 'zod';
import {api,ApiError} from '@/lib/contracts';
import {Avatar} from './primitives';
export const presenceStates={available:'Available',busy:'Busy',dnd:'Do not disturb',away:'Away',offline:'Offline'};
export const presenceState=z.enum(['available','busy','dnd','away','offline']);
const snapshot=z.object({org_id:z.uuid(),user_id:z.uuid(),state:presenceState,override:z.object({state:presenceState,until:z.iso.datetime()}).nullable()});
type State=z.infer<typeof presenceState>;
type PresenceContext={current:z.infer<typeof snapshot>|null;loading:boolean;busy:boolean;error:string;notice:string;refresh:()=>Promise<void>;setPresence:(state:State,minutes:number)=>Promise<void>;clearPresence:()=>Promise<void>};
const Context=createContext<PresenceContext|null>(null);
export function useOwnPresence(){const value=useContext(Context);if(!value)throw new Error('Presence scope is missing');return value;}
type Resource={scope:string;current:PresenceContext['current'];loading:boolean;busy:boolean;error:string;notice:string};
const empty=(scope:string):Resource=>({scope,current:null,loading:true,busy:false,error:'',notice:''});
export function PresenceProvider({org,userId,children}:{org:string;userId:string;children:ReactNode}) {
  const scope=`${userId}:${org}`,[resource,setResource]=useState(()=>empty(scope));
  const value=resource.scope===scope?resource:empty(scope);
  const patch=useCallback((next:Partial<Omit<Resource,'scope'>>)=>setResource(previous=>({...(previous.scope===scope?previous:empty(scope)),...next})),[scope]);
  const mounted=useRef(true),generation=useRef(0),writing=useRef(false),request=useRef<AbortController|null>(null),mutation=useRef<AbortController|null>(null);
  const load=useCallback(async()=>{
    request.current?.abort();const controller=new AbortController(),version=generation.current;request.current=controller;patch({loading:true,error:''});
    const active=()=>mounted.current&&version===generation.current&&!controller.signal.aborted;
    try {
      const result=snapshot.parse(await api(`/organizations/${org}/presence`,'GET',undefined,AbortSignal.any([controller.signal,AbortSignal.timeout(8000)])));
      if(result.org_id!==org||result.user_id!==userId)throw new Error('Your workspace presence could not be verified');
      if(active())patch({current:result});
    } catch(e) {if(active())patch({current:null,error:e instanceof Error?e.message:'Presence unavailable'});}
    finally {if(request.current===controller&&version===generation.current){request.current=null;if(mounted.current)patch({loading:false});}}
  },[org,userId,patch]);
  useEffect(()=>{
    mounted.current=true;const version=++generation.current;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Reset only the remote presence resource on scope changes.
    patch({current:null,loading:true,busy:false,error:'',notice:''});void load();
    const timer=setInterval(()=>{if(!writing.current&&!request.current)void load();},5000);
    return()=>{mounted.current=false;generation.current=version+1;clearInterval(timer);request.current?.abort();mutation.current?.abort();request.current=null;mutation.current=null;writing.current=false;};
  },[load,patch]);
  async function update(state:State|null,minutes?:number) {
    if(writing.current||!value.current)return;writing.current=true;request.current?.abort();request.current=null;
    const controller=new AbortController(),version=generation.current;mutation.current=controller;patch({loading:false,busy:true,error:'',notice:''});
    const active=()=>mounted.current&&version===generation.current&&!controller.signal.aborted;
    try {
      await api(`/organizations/${org}/presence`,state===null?'DELETE':'POST',state===null?{}:{state,minutes},AbortSignal.any([controller.signal,AbortSignal.timeout(8000)]));
      if(active()){patch({notice:state===null?'Automatic presence restored.':`Presence update accepted: ${presenceStates[state]} for ${minutes} minutes.`});await load();}
    } catch(e) {if(active())patch({...(e instanceof ApiError&&[401,403,404].includes(e.status)?{current:null}:{}),error:e instanceof Error?e.message:'Presence could not be updated. Try again.'});}
    finally {if(version===generation.current){writing.current=false;if(mutation.current===controller)mutation.current=null;if(mounted.current)patch({busy:false});}}
  }
  return <Context.Provider value={{...value,refresh:load,setPresence:(state,minutes)=>update(state,minutes),clearPresence:()=>update(null)}}>{children}</Context.Provider>;
}
export function ProfilePresence({name,onOpen}:{name:string;onOpen:()=>void}) {
  const {current,error}=useOwnPresence(),id=useId(),label=current?presenceStates[current.state]:error?'Presence unavailable':'Checking presence…';
  return <button className="profile-button" aria-label="Open profile settings" aria-describedby={id} onClick={onOpen}>
    <span className="profile-avatar"><Avatar name={name} small/><span className="presence-dot" data-state={current?.state??'unknown'} aria-hidden="true"/></span>
    <span id={id} className="profile-presence-label" aria-live="polite" aria-atomic="true">{label}</span>
  </button>;
}
