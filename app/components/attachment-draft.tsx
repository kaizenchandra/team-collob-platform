"use client";
import {useCallback,useEffect,useState} from 'react';
import {attachmentDraft,addDraftAttachment,setAttachmentDraft,clearAttachmentDrafts,type DraftAttachment} from '@/lib/draft-attachments';
export function useAttachmentDraft(userId:string,orgId:string,channelId:string){
  const scopeKey=`${userId}:${orgId}:${channelId}`;
  const [snapshot,setSnapshot]=useState<{key:string;files:DraftAttachment[];error:string}>({key:'',files:[],error:''});
  const reload=useCallback(()=>{
    if(!userId||!orgId||!channelId)return;
    try{setSnapshot({key:`${userId}:${orgId}:${channelId}`,files:attachmentDraft(window.sessionStorage,{userId,orgId,channelId}),error:''});}
    catch(e){setSnapshot({key:`${userId}:${orgId}:${channelId}`,files:[],error:e instanceof Error?e.message:'Attachment selections unavailable. Clear saved attachment selections to continue.'});}
  },[userId,orgId,channelId]);
  useEffect(()=>{
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Restore the actor/conversation-scoped local attachment draft.
    reload();
  },[reload]);
  const current=snapshot.key===scopeKey;
  return {
    invalidate(error:unknown){setSnapshot({key:scopeKey,files:[],error:error instanceof Error?error.message:"Attachment selections unavailable. Clear saved attachment selections to continue."});},
    files:current?snapshot.files:[],ready:current&&!snapshot.error,error:current?snapshot.error:'',reload,
    add(file:DraftAttachment){const files=addDraftAttachment(window.sessionStorage,{userId,orgId,channelId},file);setSnapshot({key:scopeKey,files,error:''});},
    remove(id:string){const files=setAttachmentDraft(window.sessionStorage,{userId,orgId,channelId},attachmentDraft(window.sessionStorage,{userId,orgId,channelId}).filter(file=>file.id!==id));setSnapshot({key:scopeKey,files,error:''});},
    clear(){clearAttachmentDrafts(window.sessionStorage);setSnapshot({key:scopeKey,files:[],error:''});},
  };
}
export function AttachmentDraft({files,error,disabled,remove,clear}:{files:DraftAttachment[];error:string;disabled:boolean;remove:(id:string)=>void;clear:()=>void}){
  if(error)return <div role="alert"><p>{error}</p><p>Clearing removes saved file selections in this tab. Stored files and unconfirmed messages are kept.</p><button className="secondary" type="button" disabled={disabled} onClick={clear}>Clear saved attachment selections</button></div>;
  if(!files.length)return null;
  return <section className="attachment-draft" aria-label="Selected attachments"><p>Not sent yet · {files.length} of 10 files. Selections are saved in this browser tab. Access and scan status are checked when you send.</p><ul>{files.map(file=><li key={file.id}><span>{file.name}</span><button className="secondary" type="button" disabled={disabled} aria-label={`Remove attachment ${file.name}`} onClick={()=>remove(file.id)}>Remove</button></li>)}</ul></section>;
}
