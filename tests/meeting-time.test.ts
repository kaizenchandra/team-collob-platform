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
