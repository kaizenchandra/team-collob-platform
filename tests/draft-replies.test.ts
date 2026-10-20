import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {draftRepliesKey,draftReply,setDraftReply,acknowledgeDraftReply,retainReplyIdentity,clearDraftReplies,type ReplyScope} from '../lib/draft-replies.ts';
class Store implements Storage{data=new Map<string,string>();get length(){return this.data.size;}clear(){this.data.clear();}key(i:number){return [...this.data.keys()][i]??null;}getItem(k:string){return this.data.get(k)??null;}setItem(k:string,v:string){this.data.set(k,v);}removeItem(k:string){this.data.delete(k);}}
const scope=():ReplyScope=>({userId:randomUUID(),orgId:randomUUID(),channelId:randomUUID()});
test('reply drafts restore only their actor/workspace/channel message ID without storing source content',()=>{
 const storage=new Store(),s=scope(),id=randomUUID();setDraftReply(storage,s,id);assert.equal(draftReply(storage,s),id);for(const change of [{userId:randomUUID()},{orgId:randomUUID()},{channelId:randomUUID()}])assert.equal(draftReply(storage,{...s,...change}),null);assert.deepEqual(JSON.parse(storage.getItem(draftRepliesKey)!),[{...s,messageId:id}]);
});
test('reply acknowledgement removes matching submitted target but preserves newer choices and other scopes',()=>{
 const storage=new Store(),a=scope(),b=scope(),old=randomUUID(),next=randomUUID();setDraftReply(storage,a,next);setDraftReply(storage,b,old);acknowledgeDraftReply(storage,a,old);acknowledgeDraftReply(storage,a,null);assert.equal(draftReply(storage,a),next);acknowledgeDraftReply(storage,a,next);assert.equal(draftReply(storage,a),null);assert.equal(draftReply(storage,b),old);
});
test('reply drafts bound32 scopes without overwrite and identity filtering retains only current actor',()=>{
 const storage=new Store(),a=scope(),id=randomUUID();setDraftReply(storage,a,id);for(let i=1;i<32;i++)setDraftReply(storage,scope(),randomUUID());const before=storage.getItem(draftRepliesKey);assert.throws(()=>setDraftReply(storage,scope(),randomUUID()),/Too many/);assert.equal(storage.getItem(draftRepliesKey),before);retainReplyIdentity(storage,a.userId);assert.deepEqual(JSON.parse(storage.getItem(draftRepliesKey)!),[{...a,messageId:id}]);setDraftReply(storage,a,null);assert.equal(storage.getItem(draftRepliesKey),null);
});
test('malformed and duplicate reply metadata fails closed without rewriting or trusting cached text',()=>{
 const storage=new Store(),a=scope(),entry={...a,messageId:randomUUID()};for(const raw of ['{invalid',JSON.stringify([entry,entry]),JSON.stringify([{...entry,messageId:'bad'}]),JSON.stringify([{...entry,body:'untrusted source content'}])]){storage.setItem(draftRepliesKey,raw);assert.throws(()=>draftReply(storage,a),/invalid/);assert.throws(()=>setDraftReply(storage,a,randomUUID()),/invalid/);assert.equal(storage.getItem(draftRepliesKey),raw);}clearDraftReplies(storage);assert.equal(draftReply(storage,a),null);
});
test('reply storage write failure preserves old target; reply clearing keeps attachment/text/pending metadata',()=>{
 const storage=new Store(),a=scope(),id=randomUUID();setDraftReply(storage,a,id);for(const key of ['concord.draft-attachments.v1','concord.pending-messages.v1','text-draft'])storage.setItem(key,'preserve');const write=storage.setItem.bind(storage);storage.setItem=()=>{throw new Error('blocked');};assert.throws(()=>setDraftReply(storage,a,randomUUID()),/Cannot save/);assert.equal(draftReply(storage,a),id);storage.setItem=write;clearDraftReplies(storage);for(const key of ['concord.draft-attachments.v1','concord.pending-messages.v1','text-draft'])assert.equal(storage.getItem(key),'preserve');
});
