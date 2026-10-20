import {z} from 'zod';
export const draftAttachmentsKey='concord.draft-attachments.v1';
const scopeSchema=z.object({userId:z.uuid(),orgId:z.uuid(),channelId:z.uuid()}).strict();
const fileSchema=z.object({id:z.uuid(),name:z.string().min(1).max(512)}).strict();
const filesSchema=z.array(fileSchema).max(10).refine(files=>new Set(files.map(f=>f.id)).size===files.length);
const entrySchema=scopeSchema.extend({files:filesSchema.min(1)}).strict();
const key=(scope:AttachmentScope)=>`${scope.userId}:${scope.orgId}:${scope.channelId}`;
const entriesSchema=z.array(entrySchema).max(32).refine(entries=>new Set(entries.map(key)).size===entries.length);
export type AttachmentScope=z.infer<typeof scopeSchema>;
export type DraftAttachment=z.infer<typeof fileSchema>;
function entries(storage:Storage){
  const raw=storage.getItem(draftAttachmentsKey);if(!raw)return [];
  let value:unknown;try{value=JSON.parse(raw);}catch{throw new Error('Saved attachment selections are invalid. Clear saved attachment selections to continue.');}
  const result=entriesSchema.safeParse(value);if(!result.success)throw new Error('Saved attachment selections are invalid. Clear saved attachment selections to continue.');return result.data;
}
function write(storage:Storage,value:z.infer<typeof entriesSchema>){
  try{if(value.length)storage.setItem(draftAttachmentsKey,JSON.stringify(value));else storage.removeItem(draftAttachmentsKey);}
  catch{throw new Error('Cannot save attachment selections. Allow browser session storage and try again.');}
}
export function attachmentDraft(storage:Storage,scope:AttachmentScope):DraftAttachment[]{return entries(storage).find(entry=>key(entry)===key(scope))?.files??[];}
export function setAttachmentDraft(storage:Storage,scope:AttachmentScope,files:DraftAttachment[]){
  const validScope=scopeSchema.parse(scope),validFiles=filesSchema.safeParse(files);if(!validFiles.success)throw new Error('Select up to 10 different files with valid names.');
  const next=entries(storage).filter(entry=>key(entry)!==key(validScope));if(files.length)next.push({...validScope,files:validFiles.data});
  if(next.length>32)throw new Error('Too many attachment drafts. Remove file selections from another conversation first.');write(storage,next);return validFiles.data;
}
export function addDraftAttachment(storage:Storage,scope:AttachmentScope,file:DraftAttachment){const files=attachmentDraft(storage,scope);return files.some(f=>f.id===file.id)?files:setAttachmentDraft(storage,scope,[...files,file]);}
export function acknowledgeDraftAttachments(storage:Storage,scope:AttachmentScope,ids:string[]){if(!ids.length)return;return setAttachmentDraft(storage,scope,attachmentDraft(storage,scope).filter(file=>!ids.includes(file.id)));}
export function retainAttachmentIdentity(storage:Storage,userId:string){write(storage,entries(storage).filter(entry=>entry.userId===userId));}
export function clearAttachmentDrafts(storage:Storage){storage.removeItem(draftAttachmentsKey);}
