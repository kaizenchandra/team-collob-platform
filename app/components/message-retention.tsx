"use client";
import {useCallback,useEffect,useId,useRef,useState} from 'react';
import {z} from 'zod';
import {api} from '@/lib/contracts';
const daysSchema=z.number().int().min(1).max(3650).nullable();
const settingsSchema=z.object({id:z.uuid(),days:daysSchema,revision:z.number().int().nonnegative(),held:z.boolean()});
const previewSchema=z.object({id:z.uuid(),days:daysSchema,policyRevision:z.number().int().nonnegative(),held:z.boolean(),asOf:z.iso.datetime(),count:z.number().int().min(0).max(100),hasMore:z.boolean(),oldestAt:z.iso.datetime().nullable(),newestAt:z.iso.datetime().nullable(),token:z.string().regex(/^[a-f0-9]{64}$/).nullable()});
type Settings=z.infer<typeof settingsSchema>;type Preview=z.infer<typeof previewSchema>;
export function MessageRetention({id}:{id:string}){
  const [data,setData]=useState<Settings|null>(null),[enabled,setEnabled]=useState(false),[days,setDays]=useState('30'),[preview,setPreview]=useState<Preview|null>(null),[confirming,setConfirming]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[loading,setLoading]=useState(true);
  const field=useId(),request=useRef<AbortController|null>(null),mounted=useRef(true);
  const load=useCallback(async()=>{
    request.current?.abort();const controller=new AbortController();request.current=controller;setLoading(true);setData(null);setPreview(null);setConfirming(false);setError('');setNotice('');
    try{const r=settingsSchema.parse(await api(`/channels/${id}/message-retention`,'GET',undefined,AbortSignal.any([controller.signal,AbortSignal.timeout(10000)])));if(r.id!==id)throw new Error('Retention scope could not be verified');if(!controller.signal.aborted){setData(r);setEnabled(r.days!==null);setDays(String(r.days??30));}}
    catch(e){if(!controller.signal.aborted)setError(e instanceof Error?e.message:'Retention settings unavailable');}
    finally{if(request.current===controller){request.current=null;setLoading(false);}}
  },[id]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- Load the resource-keyed authoritative owner settings.
  useEffect(()=>{mounted.current=true;void load();return()=>{mounted.current=false;request.current?.abort();};},[load]);
  const value=enabled?Number(days):null,valid=!enabled||(Number.isInteger(value)&&Number(value)>=1&&Number(value)<=3650),dirty=data&&value!==data.days;
  return <section aria-label="Message retention"><h3>Message retention</h3>
    <p>Workspace owners with channel access can review messages by age and clear their text in batches of up to 100. No automatic expiration job runs. Each batch needs a preview and explicit confirmation.</p>
    <button className="secondary" disabled={busy||loading} onClick={()=>void load()}>Refresh message retention</button>
    {loading&&<p role="status">Loading message retention…</p>}{error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
    {data&&<><label className="check-label"><input type="checkbox" style={{flexShrink:0,width:16,height:16}} disabled={busy||confirming} checked={enabled} onChange={e=>{setEnabled(e.target.checked);setPreview(null);setConfirming(false);}}/>Enable manual message retention</label>
      {enabled&&<><label htmlFor={field}>Message age in days</label><input id={field} type="number" min={1} max={3650} step={1} disabled={busy||confirming} value={days} onChange={e=>{setDays(e.target.value);setPreview(null);setConfirming(false);}}/></>}
      <p>Age uses creation time and elapsed 24-hour days. Saving a policy does not delete messages. Refresh replaces unsaved changes.</p>
      <button className="secondary" disabled={busy||confirming||!valid||!dirty} onClick={async()=>{
        setBusy(true);setError('');setNotice('');setPreview(null);
        try{const r=settingsSchema.parse(await api(`/channels/${id}/message-retention`,'PUT',{days:value,expectedRevision:data.revision,confirm:true}));if(r.id!==id)throw new Error('Retention scope could not be verified');if(mounted.current){setData(r);setEnabled(r.days!==null);setDays(String(r.days??30));setNotice('Retention policy saved. No messages were deleted.');}}
        catch(e){if(mounted.current)setError(e instanceof Error?e.message:'Retention policy unavailable');}
        finally{if(mounted.current)setBusy(false);}
      }}>Save retention policy</button>
      <button className="secondary" disabled={busy||confirming||!!dirty||data.days===null} onClick={async()=>{
        setBusy(true);setError('');setNotice('');setPreview(null);
        try{const r=previewSchema.parse(await api(`/channels/${id}/message-retention/preview`,'GET',undefined,AbortSignal.timeout(10000)));if(r.id!==id||r.policyRevision!==data.revision||r.days!==data.days)throw new Error('Retention policy changed. Refresh message retention before previewing.');if(mounted.current){setPreview(r);setData({...data,held:r.held});}}
        catch(e){if(mounted.current)setError(e instanceof Error?e.message:'Retention preview unavailable');}
        finally{if(mounted.current)setBusy(false);}
      }}>Preview expired messages</button>
      {preview&&<div aria-label="Retention batch preview" role="group">
        {preview.held?<p role="status">A preservation hold blocks retention. An authorized owner must release it before applying a batch.</p>:<><p>{preview.count} {preview.count===1?'message':'messages'} in this batch{preview.hasMore?'; more eligible messages require another preview.':'.'}</p>
          {preview.oldestAt&&preview.newestAt&&<p>Created from {new Date(preview.oldestAt).toLocaleString()} through {new Date(preview.newestAt).toLocaleString()}.</p>}
          {preview.count>0&&<><p>Applying this batch permanently clears message text and removes mentions. The application cannot undo it. Files, message references, moderation records and backup copies remain under their existing rules.</p>
            {!confirming?<button className="secondary" disabled={busy} onClick={()=>setConfirming(true)}>Review retention batch</button>:<div role="group" aria-label="Confirm retention batch"><p>Clear text from {preview.count} {preview.count===1?'message':'messages'} now? This cannot be undone. Preview approval expires after 10 minutes.</p>
              <button className="primary" disabled={busy} onClick={async()=>{
                setBusy(true);setError('');setNotice('');
                try{const r=z.object({ok:z.literal(true),count:z.number().int().positive().max(100),hasMore:z.boolean()}).parse(await api(`/channels/${id}/message-retention/apply`,'POST',{expectedRevision:preview.policyRevision,asOf:preview.asOf,token:preview.token,confirm:true}));if(mounted.current){setPreview(null);setConfirming(false);setNotice(`Message text cleared for ${r.count} ${r.count===1?'message':'messages'}.${r.hasMore?' Preview the next batch to continue.':''}`);}}
                catch(e){if(mounted.current){setPreview(null);setConfirming(false);setError(e instanceof Error?e.message:'Retention could not be confirmed. Preview again before retrying.');}}
                finally{if(mounted.current)setBusy(false);}
              }}>Confirm clear message text</button><button className="secondary" disabled={busy} onClick={()=>setConfirming(false)}>Cancel retention batch</button>
            </div>}
          </>}
        </>}
      </div>}
    </>}
  </section>;
}
