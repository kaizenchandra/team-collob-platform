import test from 'node:test';
import assert from 'node:assert/strict';
import {readMessageLink,messageLink} from '../lib/message-link.ts';
test('message links require unambiguous UUID scope and safe URLs without carrying unrelated URL data',()=>{
  const target={org:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',channel:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc'},link=messageLink('https://example.test/path?private=value',target);
  assert.equal(link,`https://example.test/?org=${target.org}&channel=${target.channel}#message-${target.id}`);assert.deepEqual(readMessageLink(link),target);assert.deepEqual(readMessageLink(link.toUpperCase()),null);
  assert.deepEqual(readMessageLink(`http://localhost:3101/?org=${target.org.toUpperCase()}&channel=${target.channel.toUpperCase()}#message-${target.id.toUpperCase()}`),target);
  assert.deepEqual(readMessageLink(link.replace('#message-','&tab=Files#message-')),target);
  for(const bad of ['not a URL',link.replace('org=','other='),link.replace('channel=','other='),link.replace('#message-','#message-bad-'),link+'-extra',link.replace(target.org,'bad'),link.replace('?org=',`?org=${target.org}&org=`),link.replace('&channel=',`&channel=${target.channel}&channel=`),link.replace('https:','file:'),link.replace('https://','https://user:password@'),link.replace('#message-','#message-%20')])assert.equal(readMessageLink(bad),null,bad);
  for(const origin of ['javascript:alert(1)','file:///tmp','https://user:password@example.test'])assert.throws(()=>messageLink(origin,target));assert.throws(()=>messageLink('https://example.test',{...target,id:'not-a-uuid'}));
});
