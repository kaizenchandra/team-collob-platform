import {z} from 'zod';
export const draftRepliesKey='concord.draft-replies.v1';
const scopeSchema=z.object({userId:z.uuid(),orgId:z.uuid(),channelId:z.uuid()}).strict();
const entrySchema=scopeSchema.extend({messageId:z.uuid()}).strict();
export type ReplyScope=z.infer<typeof scopeSchema>;
const key=(scope:ReplyScope)=>`${scope.userId}:${scope.orgId}:${scope.channelId}`;
const listSchema=z.array(entrySchema).max(32).refine(entries=>new Set(entries.map(key)).size===entries.length);
function read(storage:Storage){
  const raw=storage.getItem(draftRepliesKey);if(!raw)return [];
  let value:unknown;try{value=JSON.parse(raw);}catch{throw new Error('Saved reply selections are invalid. Clear saved reply selections to continue.');}
  const result=listSchema.safeParse(value);if(!result.success)throw new Error('Saved reply selections are invalid. Clear saved reply selections to continue.');return result.data;
}
function write(storage:Storage,entries:z.infer<typeof listSchema>){try{if(entries.length)storage.setItem(draftRepliesKey,JSON.stringify(entries));else storage.removeItem(draftRepliesKey);}catch{throw new Error('Cannot save reply selection. Allow browser session storage and try again.');}}
export function draftReply(storage:Storage,scope:ReplyScope){return read(storage).find(entry=>key(entry)===key(scope))?.messageId??null;}
export function setDraftReply(storage:Storage,scope:ReplyScope,messageId:string|null){
  const valid=scopeSchema.parse(scope),next=read(storage).filter(entry=>key(entry)!==key(valid));
  if(messageId!==null)next.push(entrySchema.parse({...valid,messageId}));if(next.length>32)throw new Error('Too many reply drafts. Cancel a reply in another conversation first.');write(storage,next);return messageId;
}
export function acknowledgeDraftReply(storage:Storage,scope:ReplyScope,messageId:string|null){if(messageId!==null&&draftReply(storage,scope)===messageId)setDraftReply(storage,scope,null);}
export function retainReplyIdentity(storage:Storage,userId:string){write(storage,read(storage).filter(entry=>entry.userId===userId));}
export function clearDraftReplies(storage:Storage){storage.removeItem(draftRepliesKey);}
