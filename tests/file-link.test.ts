import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileLink,fileLink} from '../lib/file-link.ts';
test('file links require unambiguous UUID scope and safe URLs without carrying unrelated URL data',()=>{
  const target={org:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',channel:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc'},link=fileLink('https://example.test/path?private=value',target);
  assert.equal(link,`https://example.test/?org=${target.org}&channel=${target.channel}#file-${target.id}`);assert.deepEqual(readFileLink(link),target);assert.deepEqual(readFileLink(link.toUpperCase()),null);
  assert.deepEqual(readFileLink(`http://localhost:3101/?org=${target.org.toUpperCase()}&channel=${target.channel.toUpperCase()}#file-${target.id.toUpperCase()}`),target);
  assert.deepEqual(readFileLink(link.replace('#file-','&tab=Files#file-')),target);
  for(const bad of ['not a URL',link.replace('org=','other='),link.replace('channel=','other='),link.replace('#file-','#file-bad-'),link+'-extra',link.replace(target.org,'bad'),link.replace('?org=',`?org=${target.org}&org=`),link.replace('&channel=',`&channel=${target.channel}&channel=`),link.replace('https:','file:'),link.replace('https://','https://user:password@'),link.replace('#file-','#file-%20'),link.replace('#file-','#message-')])assert.equal(readFileLink(bad),null,bad);
  for(const origin of ['javascript:alert(1)','file:///tmp','https://user:password@example.test'])assert.throws(()=>fileLink(origin,target));assert.throws(()=>fileLink('https://example.test',{...target,id:'not-a-uuid'}));
});
