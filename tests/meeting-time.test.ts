import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolveMeetingTime,meetingLocalTime} from '../lib/meeting-time.ts';
test('meeting timezone resolves normal and non-hour offsets',()=>{
  assert.equal(resolveMeetingTime('2026-12-22T10:00','UTC'),'2026-12-22T10:00:00.000Z');
  assert.equal(resolveMeetingTime('2026-12-22T10:00','Asia/Kolkata'),'2026-12-22T04:30:00.000Z');
  assert.equal(resolveMeetingTime('2026-12-22T10:00','Asia/Kathmandu'),'2026-12-22T04:15:00.000Z');
});
test('DST gaps are rejected for every repeated-time choice',()=>{
  for(const choice of ['reject','earlier','later'] as const)assert.throws(()=>resolveMeetingTime('2026-03-08T02:30','America/New_York',choice),/does not exist/);
});
test('DST folds require choice and resolve to distinct instants',()=>{
  assert.throws(()=>resolveMeetingTime('2026-11-01T01:30','America/New_York'),/occurs twice/);
  assert.equal(resolveMeetingTime('2026-11-01T01:30','America/New_York','earlier'),'2026-11-01T05:30:00.000Z');
  assert.equal(resolveMeetingTime('2026-11-01T01:30','America/New_York','later'),'2026-11-01T06:30:00.000Z');
});
test('invalid local date and zone cannot silently normalize',()=>{
  assert.throws(()=>resolveMeetingTime('2026-02-30T12:00','UTC'),/valid local date/);
  assert.throws(()=>resolveMeetingTime('2026-12-22T10:00Z','UTC'),/valid local date/);
  assert.throws(()=>resolveMeetingTime('2026-12-22T10:00','invalid/zone'),/valid IANA/);
});
test('editor initialization uses stored timezone for normal and folded instants',()=>{
  assert.equal(meetingLocalTime('2026-12-22T04:30:00.123Z','Asia/Kolkata'),'2026-12-22T10:00:00');
  assert.equal(meetingLocalTime('2026-11-01T06:30:00Z','America/New_York'),'2026-11-01T01:30:00');
});

test('weekly recurrence preserves local time across DST',async()=>{
  const {meetingOccurrences}=await import('../lib/meeting-recurrence.ts');
  const rows=meetingOccurrences('2026-03-01T14:00:00Z','2026-03-01T15:00:00Z','America/New_York',{frequency:'weekly',interval:1,count:3,repeatedTime:'reject'});
  assert.deepEqual(rows.map(r=>r.startsAt),['2026-03-01T14:00:00Z','2026-03-08T13:00:00.000Z','2026-03-15T13:00:00.000Z']);
});
test('recurrence rejects any invalid later occurrence and bounds expansion',async()=>{
  const {meetingOccurrences}=await import('../lib/meeting-recurrence.ts');
  assert.throws(()=>meetingOccurrences('2026-03-01T07:30:00Z','2026-03-01T08:30:00Z','America/New_York',{frequency:'weekly',interval:1,count:2,repeatedTime:'later'}),/does not exist/);
  assert.throws(()=>meetingOccurrences('2026-10-25T05:30:00Z','2026-10-25T07:30:00Z','America/New_York',{frequency:'weekly',interval:1,count:2,repeatedTime:'reject'}),/occurs twice/);
  assert.throws(()=>meetingOccurrences('2026-01-01T10:00:00Z','2026-01-01T11:00:00Z','UTC',{frequency:'weekly',interval:12,count:52,repeatedTime:'reject'}),/366 days/);
});

test('monthly rules anchor to original date without short-month drift',async()=>{
  const {meetingOccurrences}=await import('../lib/meeting-recurrence.ts');
  const rule={frequency:'monthly',interval:1,count:4,repeatedTime:'reject',monthDayPolicy:'constrain'} as const;
  const rows=meetingOccurrences('2030-01-31T10:00:00Z','2030-01-31T11:00:00Z','UTC',rule);
  assert.deepEqual(rows.map(r=>r.startsAt.slice(0,10)),['2030-01-31','2030-02-28','2030-03-31','2030-04-30']);
  assert.throws(()=>meetingOccurrences('2030-01-31T10:00:00Z','2030-01-31T11:00:00Z','UTC',{...rule,monthDayPolicy:'reject'}),/Occurrence 2/);
});
test('monthly overnight duration follows clamped start rather than a drifting end anchor',async()=>{
  const {meetingOccurrences}=await import('../lib/meeting-recurrence.ts');
  const rows=meetingOccurrences('2030-01-31T23:00:00Z','2030-02-01T01:00:00Z','UTC',{frequency:'monthly',interval:1,count:2,repeatedTime:'reject',monthDayPolicy:'constrain'});
  assert.equal(rows[1].startsAt,'2030-02-28T23:00:00.000Z');assert.equal(rows[1].endsAt,'2030-03-01T01:00:00.000Z');
});
test('yearly leap-day anchoring and five-year horizon are explicit',async()=>{
  const {meetingOccurrences}=await import('../lib/meeting-recurrence.ts');const rule={frequency:'yearly',interval:1,count:5,repeatedTime:'reject',monthDayPolicy:'constrain'} as const;
  const rows=meetingOccurrences('2024-02-29T10:00:00Z','2024-02-29T11:00:00Z','UTC',rule);assert.deepEqual(rows.map(r=>r.startsAt.slice(0,10)),['2024-02-29','2025-02-28','2026-02-28','2027-02-28','2028-02-29']);
  assert.throws(()=>meetingOccurrences('2024-02-29T10:00:00Z','2024-02-29T11:00:00Z','UTC',{...rule,count:7}),/5 calendar years/);
});
