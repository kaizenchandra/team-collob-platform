import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {pendingCallChat,saveCallChat,acknowledgeCallChat,clearMeetingPending} from '../lib/pending-call-chat.ts';
test('call message retry recovers the immutable identity and isolates users, calls and rooms',()=>{
 const data=new Map<string,string>(),storage={getItem:(k:string)=>data.get(k)??null,setItem:(k:string,v:string)=>{data.set(k,v);},removeItem:(k:string)=>{data.delete(k);}},row={user:randomUUID(),call:randomUUID(),room:randomUUID(),clientId:randomUUID(),body:'Accepted despite lost acknowledgement',createdAt:Date.now()};
 saveCallChat(storage,row);assert.deepEqual(pendingCallChat(storage,row.user,row.call,row.room),row);assert.equal(pendingCallChat(storage,randomUUID(),row.call,row.room),null);assert.equal(pendingCallChat(storage,row.user,randomUUID(),row.room),null);assert.equal(pendingCallChat(storage,row.user,row.call,randomUUID()),null);saveCallChat(storage,row);assert.throws(()=>saveCallChat(storage,{...row,body:'Changed'}));acknowledgeCallChat(storage,randomUUID());assert.deepEqual(pendingCallChat(storage,row.user,row.call,row.room),row);acknowledgeCallChat(storage,row.clientId);assert.equal(pendingCallChat(storage,row.user,row.call,row.room),null);saveCallChat(storage,row);data.set('unrelated','preserve');clearMeetingPending(storage);assert.equal(data.get('unrelated'),'preserve');assert.equal(pendingCallChat(storage,row.user,row.call,row.room),null);
});
test('call retry storage rejects corrupt records, expires old retries and surfaces write failure',()=>{
 let raw='invalid';const storage={getItem:()=>raw,setItem:(_k:string,v:string)=>{raw=v;},removeItem:()=>{raw='[]';}};assert.throws(()=>pendingCallChat(storage,randomUUID(),randomUUID(),randomUUID()));const row={user:randomUUID(),call:randomUUID(),room:randomUUID(),clientId:randomUUID(),body:'Old',createdAt:Date.now()-86400001};raw=JSON.stringify([row]);assert.equal(pendingCallChat(storage,row.user,row.call,row.room),null);assert.throws(()=>saveCallChat({...storage,setItem:()=>{throw new Error('storage unavailable');}},{...row,createdAt:Date.now()}),/storage unavailable/);
});
