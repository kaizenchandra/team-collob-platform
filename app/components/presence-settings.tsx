"use client";
import {useId,useState} from 'react';
import {presenceStates as states,presenceState as stateSchema,useOwnPresence} from './presence-provider';
export function PresenceSettings() {
  const {current,loading,busy,error,notice,refresh:load,setPresence,clearPresence}=useOwnPresence();
  const [state,setState]=useState<keyof typeof states>('available'),[minutes,setMinutes]=useState('30');
  const stateId=useId(),durationId=useId();
  return <section className="card settings-form" aria-label="Workspace presence"><h2>Workspace presence</h2>
    <p>This setting applies to the selected workspace. Overrides expire back to Available while connected. After a minute without a heartbeat, you appear Offline.</p>
    {current&&<p>Current workspace presence: <strong>{states[current.state]}</strong></p>}
    {current&&(current.override?<p>Override: {states[current.override.state]} until <time dateTime={current.override.until}>{new Date(current.override.until).toLocaleString()}</time>.</p>:<p>Automatic presence is active.</p>)}
    {current?.override&&<button className="secondary" disabled={busy} onClick={()=>void clearPresence()}>Return to automatic presence</button>}
    {loading&&<p role="status">Refreshing presence…</p>}{error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
    <button className="secondary" disabled={busy} onClick={()=>void load()}>Refresh presence</button>
    <form className="presence-form" onSubmit={e=>{e.preventDefault();void setPresence(state,Number(minutes));}}>
      <label htmlFor={stateId}>Presence state</label><select id={stateId} value={state} disabled={busy} onChange={e=>setState(stateSchema.parse(e.target.value))}>{Object.entries(states).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select>
      <label htmlFor={durationId}>Presence duration</label><select id={durationId} value={minutes} disabled={busy} onChange={e=>setMinutes(e.target.value)}><option value="15">15 minutes</option><option value="30">30 minutes</option><option value="60">1 hour</option><option value="240">4 hours</option><option value="480">8 hours</option></select>
      <button className="primary" disabled={busy||!current}>Set presence</button>
    </form>
    <p>Do not disturb changes your displayed presence. Notification preferences are managed separately.</p>
  </section>;
}
