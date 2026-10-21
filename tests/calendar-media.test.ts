import {test} from 'node:test';
import assert from 'node:assert/strict';
import {scheduledJoinWindow} from '../services/core/calendar-media.ts';
import type {DB} from '../services/core/db.ts';
function db(starts:number,ends:number,started=false){return {query:async()=>({rows:[{starts_at:new Date(starts),ends_at:new Date(ends),started}]})} as unknown as DB;}
test('unused prepared rooms obey the scheduled join window at token issuance',async()=>{const now=Date.now();await assert.rejects(scheduledJoinWindow(db(now+16*60000,now+3600000),'prepared'),{statusCode:409});await assert.rejects(scheduledJoinWindow(db(now-3600000,now-60000),'prepared'),{statusCode:409});await scheduledJoinWindow(db(now+14*60000,now+3600000),'prepared');});
test('actual meeting attendance permits joining an ongoing call beyond its planned end',async()=>{const now=Date.now();await scheduledJoinWindow(db(now-3600000,now-60000,true),'running');});
test('instant calls retain their existing lifecycle policy',async()=>{await scheduledJoinWindow({query:async()=>({rows:[]})} as unknown as DB,'instant');});
