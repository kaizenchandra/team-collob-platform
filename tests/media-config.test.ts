import test from 'node:test';
import assert from 'node:assert/strict';
import {TokenVerifier} from 'livekit-server-sdk';
import {meetingLimits,mediaConfiguration,mediaToken} from '../services/core/media-config.ts';
const local:NodeJS.ProcessEnv & {LIVEKIT_API_KEY:string;LIVEKIT_API_SECRET:string}={NODE_ENV:'development',LIVEKIT_ALLOW_INSECURE_LOCAL:'true',LIVEKIT_URL:'ws://localhost:7880',LIVEKIT_API_URL:'http://localhost:7880',LIVEKIT_API_KEY:'test-key',LIVEKIT_API_SECRET:'test-media-secret-at-least-thirty-two-characters'};
test('media configuration fails closed for partial, insecure production and embedded credentials',()=>{
 assert.equal(mediaConfiguration({NODE_ENV:"test"}),null);
 assert.throws(()=>mediaConfiguration({NODE_ENV:"test",LIVEKIT_URL:local.LIVEKIT_URL}),/incomplete/);
 assert.ok(mediaConfiguration(local));
 assert.throws(()=>mediaConfiguration({...local,NODE_ENV:'production'}),/secure/);
 assert.throws(()=>mediaConfiguration({...local,LIVEKIT_URL:'ws://user:password@localhost:7880'}),/secure/);
 assert.throws(()=>mediaConfiguration({...local,LIVEKIT_API_SECRET:'short'}),/32/);
 assert.ok(mediaConfiguration({...local,NODE_ENV:'production',LIVEKIT_URL:'wss://media.example.test',LIVEKIT_API_URL:'https://media.example.test'}));
});
test('join JWT is short lived and scoped to opaque identity and current physical room',async()=>{
 const previous={...process.env};Object.assign(process.env,local);
 try{
  const value=await mediaToken('opaque-device-identity','Test user','logical-room','physical-generation');
  const claims=await new TokenVerifier(local.LIVEKIT_API_KEY,local.LIVEKIT_API_SECRET).verify(value.token);
  assert.equal(claims.sub,'opaque-device-identity');assert.equal(claims.video?.room,'cc-physical-generation');assert.equal(claims.video?.roomJoin,true);assert.equal(claims.video?.canPublishData,false);assert.equal(claims.video?.canUpdateOwnMetadata,false);assert.ok(!claims.video?.roomAdmin);assert.ok(!claims.video?.roomCreate);assert.ok(!claims.video?.roomRecord);assert.ok(claims.exp!-claims.nbf!<=15);
  assert.equal(value.roomId,'logical-room');assert.equal(value.roomVersion,'physical-generation');
 }finally{for(const key of Object.keys(local)){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}}
});

test('meeting capacity overrides are bounded and reject malformed deployment policies',()=>{
 assert.deepEqual(meetingLimits({}),{participants:32,invitations:100,calls:32});assert.deepEqual(meetingLimits({MEDIA_PARTICIPANT_LIMIT:'8',MEDIA_INVITATION_LIMIT:'20',MEDIA_ACTIVE_CALL_LIMIT:'4'}),{participants:8,invitations:20,calls:4});for(const env of [{MEDIA_PARTICIPANT_LIMIT:'33'},{MEDIA_ACTIVE_CALL_LIMIT:'0'},{MEDIA_INVITATION_LIMIT:'NaN'}])assert.throws(()=>meetingLimits(env));
});
