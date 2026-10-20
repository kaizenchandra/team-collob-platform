import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {draftAttachmentsKey,attachmentDraft,setAttachmentDraft,addDraftAttachment,acknowledgeDraftAttachments,retainAttachmentIdentity,clearAttachmentDrafts,type AttachmentScope} from '../lib/draft-attachments.ts';
class Store implements Storage{data=new Map<string,string>();get length(){return this.data.size;}clear(){this.data.clear();}key(i:number){return [...this.data.keys()][i]??null;}getItem(k:string){return this.data.get(k)??null;}setItem(k:string,v:string){this.data.set(k,v);}removeItem(k:string){this.data.delete(k);}}
const scope=():AttachmentScope=>({userId:randomUUID(),orgId:randomUUID(),channelId:randomUUID()}),file=()=>({id:randomUUID(),name:'literal <file>.txt'});
test('attachment drafts isolate actor/workspace/channel, deduplicate files and restore exact display metadata',()=>{
 const s=new Store(),a=scope(),f=file();addDraftAttachment(s,a,f);addDraftAttachment(s,a,f);assert.deepEqual(attachmentDraft(s,a),[f]);for(const change of [{userId:randomUUID()},{orgId:randomUUID()},{channelId:randomUUID()}])assert.deepEqual(attachmentDraft(s,{...a,...change}),[]);assert.deepEqual(attachmentDraft(s,{...a}),[f]);
});
test('attachment drafts enforce ten files and32 scopes without overwriting existing metadata',()=>{
 const s=new Store(),a=scope(),files=Array.from({length:10},file);setAttachmentDraft(s,a,files);const before=s.getItem(draftAttachmentsKey);assert.throws(()=>addDraftAttachment(s,a,file()),/up to 10/);assert.equal(s.getItem(draftAttachmentsKey),before);for(let n=1;n<32;n++)setAttachmentDraft(s,scope(),[file()]);const full=s.getItem(draftAttachmentsKey);assert.throws(()=>setAttachmentDraft(s,scope(),[file()]),/Too many/);assert.equal(s.getItem(draftAttachmentsKey),full);setAttachmentDraft(s,a,[]);setAttachmentDraft(s,scope(),[file()]);
});
test('acknowledged attachment IDs clear only their submitted scope and preserve newer selections',()=>{
 const s=new Store(),a=scope(),b=scope(),first=file(),later=file();setAttachmentDraft(s,a,[first,later]);setAttachmentDraft(s,b,[first]);acknowledgeDraftAttachments(s,a,[first.id]);assert.deepEqual(attachmentDraft(s,a),[later]);assert.deepEqual(attachmentDraft(s,b),[first]);acknowledgeDraftAttachments(s,a,[first.id]);assert.deepEqual(attachmentDraft(s,a),[later]);acknowledgeDraftAttachments(s,a,[later.id]);assert.deepEqual(attachmentDraft(s,a),[]);setAttachmentDraft(s,a,[later]);retainAttachmentIdentity(s,a.userId);assert.deepEqual(attachmentDraft(s,a),[later]);assert.deepEqual(attachmentDraft(s,b),[]);acknowledgeDraftAttachments(s,a,[later.id]);assert.equal(s.getItem(draftAttachmentsKey),null);
});
test('malformed, duplicate and unknown attachment draft metadata fails closed before mutation',()=>{
 const s=new Store(),a=scope(),f=file();for(const raw of ['{broken',JSON.stringify([{...a,files:[f,f]}]),JSON.stringify([{...a,files:[{...f,state:'ready'}]}]),JSON.stringify([{...a,files:[f]},{...a,files:[f]}]),JSON.stringify([{...a,files:[{id:'invalid',name:'bad'}]}])]){s.setItem(draftAttachmentsKey,raw);assert.throws(()=>attachmentDraft(s,a),/invalid/);assert.throws(()=>addDraftAttachment(s,a,f),/invalid/);assert.equal(s.getItem(draftAttachmentsKey),raw);}clearAttachmentDrafts(s);assert.deepEqual(attachmentDraft(s,a),[]);
});
test('attachment write failure preserves prior selection and clearing never touches message retry journal',()=>{
 const s=new Store(),a=scope(),first=file();setAttachmentDraft(s,a,[first]);s.setItem('concord.pending-messages.v1','retained retry metadata');const write=s.setItem.bind(s);s.setItem=()=>{throw new Error('blocked');};assert.throws(()=>addDraftAttachment(s,a,file()),/Cannot save/);assert.deepEqual(attachmentDraft(s,a),[first]);s.setItem=write;clearAttachmentDrafts(s);assert.equal(s.getItem('concord.pending-messages.v1'),'retained retry metadata');
});
