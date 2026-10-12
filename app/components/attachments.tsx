"use client";
import { useEffect, useState } from "react";
import { api, API, type Message } from "../../lib/contracts";
type FileChoice={id:string;name:string;state:string};
export function AttachmentPicker({channelId,select,openFiles}:{channelId:string;select:(id:string)=>void;openFiles:()=>void}) {
  const [files,setFiles]=useState<FileChoice[]>([]),[loading,setLoading]=useState(true),[error,setError]=useState(""),[attempt,setAttempt]=useState(0);
  useEffect(()=>{
    let active=true;
    api<{files:FileChoice[]}>(`/channels/${channelId}/files`).then(r=>{if(active)setFiles(r.files);}).catch(()=>{if(active)setError("Files could not be loaded. Check your access and retry.");}).finally(()=>{if(active)setLoading(false);});
    return ()=>{active=false;};
  },[channelId,attempt]);
  return <div className="modal-body">
    <p>Send a scanned file with your current message. Only people with access to this conversation can download it.</p>
    <button type="button" onClick={openFiles}>Upload in Files</button>
    {loading ? <p role="status">Loading files…</p> : error ? <div role="alert">{error}<button onClick={()=>{setLoading(true);setError("");setAttempt(v=>v+1);}}>Retry files</button></div> : <>
      {!files.length && <p>No files yet. Upload a file and wait for its scan to finish.</p>}
      {files.map(f=><div className="file-row" key={f.id}><span>{f.name}</span>{f.state==="ready" ? <button type="button" onClick={()=>select(f.id)} aria-label={`Send file ${f.name}`}>Send file</button> : <span>Unavailable — {f.state}</span>}</div>)}
      <button type="button" onClick={()=>{setLoading(true);setAttempt(v=>v+1);}}>Refresh files</button>
    </>}
  </div>;
}
export function MessageAttachments({channelId,attachments}:{channelId:string;attachments:Message["attachments"]}) {
  if(!attachments.length)return null;
  return <ul aria-label="Message attachments">{attachments.map(f=><li key={f.id}>{f.state==="ready" && f.name ? <a href={`${API}/v1/channels/${channelId}/files/${f.id}/download`} download>{f.name}</a> : <span>Attachment unavailable</span>}</li>)}</ul>;
}
