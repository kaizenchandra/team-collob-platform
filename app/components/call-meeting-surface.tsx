"use client";
import {useEffect,useId,useRef,useState} from 'react';
import {Mic,MicOff,Video,VideoOff,ScreenShare,ScreenShareOff,Hand,Users,MessageSquare,Settings2,PhoneOff,Pin,PinOff,X,Volume2,type LucideIcon} from 'lucide-react';
import {Track,type Room,type Participant} from 'livekit-client';
import {CallCollaboration} from './call-collaboration';
import {api} from '@/lib/contracts';
import type {MediaGrant,MediaState} from '@/lib/media-contracts';

type Panel='chat'|'participants'|'settings';
function Control({label,icon:Icon,onClick,disabled,pressed,danger=false}:{label:string;icon:LucideIcon;onClick:()=>void;disabled?:boolean;pressed?:boolean;danger?:boolean}){
 return <button className={`call-control ${danger?'call-control-danger':''}`} title={label} aria-label={label} aria-pressed={pressed} disabled={disabled} onClick={onClick}><Icon size={20} aria-hidden="true"/><span>{label}</span></button>;
}
export function CallMeetingSurface({onSettingsVisibility,unmutePrompt,room,connection,error,notice,busy,grant,base,state,userId,visible,moderation,settings,diagnostics,deviceControls,onRefresh,onLeave,onEnd,run,onMicrophone,onCamera,onShare,onPlayback,renderTrack}:{onSettingsVisibility:(shown:boolean)=>void;unmutePrompt:React.ReactNode;room:Room|null;connection:string;error:string;notice:string;busy:boolean;grant:MediaGrant;base:string;state:MediaState|null;userId:string;visible:boolean;moderation:React.ReactNode;settings:React.ReactNode;diagnostics:React.ReactNode;deviceControls:React.ReactNode;onRefresh:()=>Promise<void>;onLeave:()=>void;onEnd:()=>Promise<void>;run:(fn:()=>Promise<unknown>)=>Promise<void>;onMicrophone:()=>Promise<void>;onCamera:()=>Promise<void>;onShare:()=>Promise<void>;onPlayback:()=>Promise<void>;renderTrack:(track:Track,local:boolean,index:number)=>React.ReactNode}){
 const [panel,setPanel]=useState<Panel|null>(null),[unread,setUnread]=useState(0),[layout,setLayout]=useState<'grid'|'speaker'>('grid'),[pinned,setPinned]=useState(''),[confirmEnd,setConfirmEnd]=useState(false);
 useEffect(()=>{onSettingsVisibility(panel==='settings'&&visible);},[panel,visible,onSettingsVisibility]);
 const stage=useRef<HTMLDivElement|null>(null);
 const panelTitle=useRef<HTMLHeadingElement|null>(null),trigger=useRef<HTMLButtonElement|null>(null),endButton=useRef<HTMLButtonElement|null>(null),confirmButton=useRef<HTMLButtonElement|null>(null),id=useId();
 const participants:Participant[]=room?[...room.remoteParticipants.values(),room.localParticipant]:[],local=room?.localParticipant;
 const focused=participants.some(p=>p.identity===pinned)?pinned:participants.find(p=>p!==local&&p.isSpeaking)?.identity??participants.find(p=>p!==local)?.identity??local?.identity;
 const sharing=participants.find(p=>p.isScreenShareEnabled),share=sharing?.getTrackPublication(Track.Source.ScreenShare)?.track;
 const roster=state?.participants.filter(p=>p.room_id===grant.roomId)??[],raised=roster.filter(p=>p.hand_raised_at).sort((a,b)=>BigInt(a.hand_order??'0')<BigInt(b.hand_order??'0')?-1:1),ownRaised=!!roster.find(p=>p.id===grant.grantId)?.hand_raised_at,host=state?.call.hostUserId===userId;
 const connected=connection==='connected',disabled=!room||busy||!connected;
 const presenting=!!sharing;
 useEffect(()=>{if(stage.current)stage.current.scrollTop=0;},[presenting]);
 useEffect(()=>{if(panel)panelTitle.current?.focus();},[panel]);
 useEffect(()=>{if(confirmEnd)confirmButton.current?.focus();},[confirmEnd]);
 function toggle(value:Panel,event:React.MouseEvent<HTMLButtonElement>){trigger.current=event.currentTarget;if(panel===value){setPanel(null);event.currentTarget.focus();}else setPanel(value);}
 function closePanel(){setPanel(null);trigger.current?.focus();}
 function closeEnd(){setConfirmEnd(false);endButton.current?.focus();}
 const panelButton=(value:Panel,label:string,Icon:LucideIcon)=><button className="call-control" title={label} aria-label={label} aria-expanded={panel===value} aria-controls={`${id}-panel`} onClick={e=>toggle(value,e)}><Icon size={20} aria-hidden="true"/><span>{label}</span></button>;
 return <section aria-label="Live call" className="media-session meeting-surface">
  <div className="call-connection" role="status" aria-live="polite"><span className={`connection-dot ${connected?'connected':''}`} aria-hidden="true"/>Connection: {connection}{participants.length>0&&<span> · {participants.length} {participants.length===1?'participant':'participants'}</span>}{busy&&<span> · Updating…</span>}</div>
  {error&&<p className="call-feedback" role="alert">{error}</p>}{notice&&<p className="call-feedback" role="status">{notice}</p>}
  {room&&connected&&!room.canPlaybackAudio&&<p role="alert" className="call-feedback">Your browser blocked audio. <button onClick={()=>void run(onPlayback)}><Volume2 size={18}/>Enable audio playback</button></p>}
  {unmutePrompt}
  <div className={`call-body ${panel?'panel-open':''}`}>
   <div ref={stage} className={`call-stage ${presenting?'is-presenting':''}`} aria-label="Meeting stage">
    <div className="call-view-options"><label>Meeting layout<select value={layout} onChange={e=>setLayout(e.target.value as 'grid'|'speaker')}><option value="grid">Grid</option><option value="speaker">Active speaker</option></select></label><span>Pinning changes only your view</span></div>
    {sharing&&<section className="call-presentation" aria-label={`${sharing.name??'Participant'} is presenting`}><h3><ScreenShare size={18}/>{sharing.name??'Participant'} is presenting</h3>{share?renderTrack(share,sharing===local,0):<p role="status">Connecting shared content…</p>}</section>}
    {participants.length===1&&<p className="call-waiting" role="status">Waiting for others to join. You can keep your microphone or camera off.</p>}
    {!connected&&<p className="call-waiting" role="status">{connection.toLowerCase().includes('reconnect')?'Reconnecting your media. Your meeting state is preserved.':'Connecting to the meeting…'}</p>}
    <div className={`media-grid call-gallery ${participants.length===2?'two-person':''} ${layout==='speaker'?'speaker-layout':''} ${sharing?'presentation-thumbnails':''}`}>
     {participants.map((p,index)=>{const isLocal=p===local,camera=p.getTrackPublication(Track.Source.Camera),track=!camera?.isMuted?camera?.track:undefined;return <article className={`media-tile ${isLocal?'local-tile':''} ${p.identity===focused?'focused-tile':''} ${p.isSpeaking?'is-speaking':''}`} key={p.identity} aria-label={`${isLocal?'You':p.name??'Participant'} media`}>
      <div className="call-tile-media">{track?renderTrack(track,isLocal,index):<div className="call-avatar-wrap"><span className="meeting-avatar" aria-hidden="true">{(p.name??'?').split(' ').map(n=>n[0]).slice(0,2).join('')}</span><p>{p.isCameraEnabled?'Video connecting or unavailable':'Camera off'}</p></div>}</div>
      <div className="call-tile-caption"><div><h3 title={p.name}>{p.name??'Participant'}{isLocal?' (you)':''}</h3><p>{p.isSpeaking?'Speaking · ':''}{p.isMicrophoneEnabled?'Microphone on':'Microphone muted'} · {p.isCameraEnabled?'Camera on':'Camera off'}{p.connectionQuality==='lost'?' · Connection interrupted':''}</p>{raised.some(g=>g.id===p.identity)&&<span className="hand-badge"><Hand size={14}/>Hand raised</span>}</div><button className="call-pin" title={`${pinned===p.identity?'Unpin':'Pin'} ${p.name} (only for you)`} aria-label={`${pinned===p.identity?'Unpin':'Pin'} ${p.name}`} aria-pressed={pinned===p.identity} onClick={()=>{setPinned(pinned===p.identity?'':p.identity);setLayout('speaker');}}>{pinned===p.identity?<PinOff size={18}/>:<Pin size={18}/>}</button></div>
      {[...p.audioTrackPublications.values()].filter(pub=>!!pub.track&&!pub.isMuted).map(pub=><span key={pub.trackSid}>{renderTrack(pub.track!,isLocal,index)}</span>)}
     </article>;})}
    </div>
   </div>
   <aside id={`${id}-panel`} className="call-panel" hidden={!panel} onKeyDown={e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();closePanel();}}}>
    <header><h3 ref={panelTitle} tabIndex={-1}>{panel==='chat'?'Call chat':panel==='participants'?'Participants':'Device settings'}</h3><button className="icon-button" aria-label="Close call panel" title="Close call panel" onClick={closePanel}><X size={20}/></button></header>
    <div hidden={panel!=='chat'}><CallCollaboration key={`${grant.grantId}:${grant.roomId}`} userId={userId} base={base} grant={grant} state={state} onRefresh={onRefresh} embedded open={panel==='chat'} visible={visible&&panel==='chat'} onUnreadChange={setUnread}/></div>
    <section hidden={panel!=='participants'} aria-label="Participants"><section aria-label="Raised hands"><h3>Raised hands</h3>{raised.length?<ol>{raised.map(p=><li key={p.id}>{p.name} · Hand raised</li>)}</ol>:<p>No hands raised</p>}</section><ul className="call-roster">{roster.map(g=>{const p=participants.find(p=>p.identity===g.id);return <li key={g.id}><strong>{g.name}</strong><span>{g.user_id===state?.call.hostUserId?'Host':'Participant'} · {g.disconnected_at?'Reconnecting':p?'Connected':'Connecting'}</span><span>{!p?'Media status unavailable':p.isMicrophoneEnabled?'Microphone on':'Microphone muted'} · {!p?'Video status unavailable':p.isCameraEnabled?'Camera on':'Camera off'}{g.hand_raised_at?' · Hand raised':''}</span></li>;})}</ul>{moderation}</section>
    <section hidden={panel!=='settings'} aria-label="Call settings">{deviceControls}{settings}{diagnostics}<button className="secondary" disabled={!room} onClick={()=>void run(onPlayback)}>Enable audio playback</button></section>
   </aside>
  </div>
  <div className="call-toolbar" role="toolbar" aria-label="Call controls" onKeyDown={e=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;const buttons=Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')),index=buttons.indexOf(document.activeElement as HTMLButtonElement);if(index<0)return;e.preventDefault();buttons[e.key==='Home'?0:e.key==='End'?buttons.length-1:(index+(e.key==='ArrowRight'?1:-1)+buttons.length)%buttons.length]?.focus();}}>
   <Control label={local?.isMicrophoneEnabled?'Mute microphone':'Unmute microphone'} icon={local?.isMicrophoneEnabled?Mic:MicOff} pressed={!!local?.isMicrophoneEnabled} disabled={disabled} onClick={()=>void run(onMicrophone)}/>
   <Control label={local?.isCameraEnabled?'Turn camera off':'Turn camera on'} icon={local?.isCameraEnabled?Video:VideoOff} pressed={!!local?.isCameraEnabled} disabled={disabled} onClick={()=>void run(onCamera)}/>
   <Control label={local?.isScreenShareEnabled?'Stop screen sharing':'Share screen'} icon={local?.isScreenShareEnabled?ScreenShareOff:ScreenShare} pressed={!!local?.isScreenShareEnabled} disabled={disabled||typeof navigator.mediaDevices?.getDisplayMedia!=='function'} onClick={()=>void run(onShare)}/>
   <Control label={ownRaised?'Lower hand':'Raise hand'} icon={Hand} pressed={ownRaised} disabled={disabled||!state} onClick={()=>void run(async()=>{await api(`${base}/connections/${grant.grantId}/hand`,'POST',{raised:!ownRaised});await onRefresh();})}/>
   {panelButton('participants','Participants',Users)}{panelButton('chat',`Call chat${unread?` (${unread} unread)`:''}`,MessageSquare)}{panelButton('settings','Device settings',Settings2)}
   <div className="call-destructive"><Control label="Leave call" icon={PhoneOff} danger onClick={onLeave}/>{host&&<button ref={endButton} className="call-control call-end" title="End this meeting for all participants" disabled={busy} onClick={()=>setConfirmEnd(true)}>End call for everyone</button>}</div>
  </div>
  {typeof navigator.mediaDevices?.getDisplayMedia!=='function'&&<p className="call-support">Screen sharing is unavailable in this browser.</p>}
  {confirmEnd&&host&&<div className="call-end-backdrop"><section role="alertdialog" aria-modal="true" aria-label="End meeting confirmation" className="call-end-confirm" onKeyDown={e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();closeEnd();}if(e.key==='Tab'){e.preventDefault();(document.activeElement===confirmButton.current?e.currentTarget.querySelector<HTMLButtonElement>('.keep-meeting'):confirmButton.current)?.focus();}}}><h3>End this meeting for everyone?</h3><p>All participants will be disconnected. You can leave independently instead.</p><button ref={confirmButton} className="primary" disabled={busy} onClick={()=>void run(async()=>{await onEnd();setConfirmEnd(false);})}>Confirm end meeting</button><button className="secondary keep-meeting" disabled={busy} onClick={closeEnd}>Keep meeting open</button></section></div>}
 </section>;
}
