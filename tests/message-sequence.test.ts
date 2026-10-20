import {test} from 'node:test';
import assert from 'node:assert/strict';
import {messageSequence,readSequence,readersAt,receiptSnapshot,sequenceBefore} from '../lib/message-sequence.ts';
const alice='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',bob='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
test('read sequences preserve adjacent bigint values and reject coercion, unsafe numbers and overflow',()=>{
  for(const value of ['0','9007199254740992','9007199254740993','9223372036854775807'])assert.equal(readSequence.parse(value),value);
  for(const value of [0,42,Number.MAX_SAFE_INTEGER])assert.equal(readSequence.parse(value),String(value));
  for(const value of ['',true,null,{},[],' 1','01','+1','1e3','1.0','-1','9223372036854775808','9'.repeat(1000),Number.MAX_SAFE_INTEGER+1,1.5,Infinity,NaN])assert.equal(readSequence.safeParse(value).success,false,String(value));
  assert.equal(sequenceBefore('9007199254740992','9007199254740993'),true);
  assert.equal(sequenceBefore('9007199254740993','9007199254740992'),false);
  assert.equal(messageSequence.safeParse(1).success,false);
});
test('shared readers exclude the author and cannot round a prior position into a later read',()=>{
  const receipts=[{user_id:alice,name:'Alice',seq:'9007199254740993'},{user_id:bob,name:'Bob',seq:'9007199254740992'}];
  assert.deepEqual(readersAt(receipts,'9007199254740993',alice),[]);
  assert.deepEqual(readersAt(receipts,'9007199254740992',alice),['Bob']);
  assert.deepEqual(readersAt([{...receipts[1],seq:'9007199254740993'}],'9007199254740993',alice),['Bob']);
});
test('receipt snapshots bound data and reject duplicate identities, invalid sequences and malformed rows',()=>{
  const row={user_id:bob,name:'Bob',seq:'0'};assert.deepEqual(receiptSnapshot.parse({receipts:[row]}).receipts,[row]);
  for(const value of [{receipts:[row,row]},{receipts:Array(101).fill(row)},{receipts:[{...row,seq:'invalid'}]},{receipts:[{...row,name:''}]},{receipts:[{...row,user_id:'invalid'}]},{receipts:[{...row,seq:0}]},{receipts:null},{}])assert.equal(receiptSnapshot.safeParse(value).success,false);
});
