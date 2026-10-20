import {test,expect,chromium,type BrowserContext} from '@playwright/test';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import type * as LiveKit from 'livekit-client';
const api='http://localhost:4100',org='11111111-1111-4111-8111-111111111111',headers={origin:'http://localhost:3101'},base=`${api}/v1/organizations/${org}/calls`;
// Explicitly opt in: this is a bounded SFU audio/device-capacity probe, not a 32-user UI benchmark.
test('configured 32-device capacity exchanges audio and rejects the next device',async()=>{
 test.skip(process.env.RUN_MEDIA_CAPACITY!=='1','Set RUN_MEDIA_CAPACITY=1 against an otherwise idle local media deployment');test.setTimeout(180000);
 const browser=await chromium.launch({channel:'chrome',args:['--host-resolver-rules=MAP localhost 127.0.0.1','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--autoplay-policy=no-user-gesture-required']}),contexts=await Promise.all([1,2].map(()=>browser.newContext({permissions:['microphone','camera']}))),grants:{ctx:BrowserContext;grantId:string;roomId:string;roomVersion:string;identity:string;url:string;token:string}[]=[];let call='',timer:ReturnType<typeof setInterval>|undefined,pending=false;const pages=await Promise.all(contexts.map(c=>c.newPage()));
 try{
  for(const [i,email] of ['alice@acme.test','bob@acme.test'].entries())expect((await contexts[i].request.post(`${api}/v1/session`,{headers,data:{email,password:'Development123!'}})).status()).toBe(200);
  const made=await contexts[0].request.post(`${api}/v1/organizations/${org}/instant-meetings`,{headers,data:{clientId:randomUUID(),title:'32-device SFU audio capacity',mode:'audio',userIds:['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb']}});expect(made.status()).toBe(200);call=(await made.json()).id;
  for(const page of pages){await page.goto('http://localhost:3101');await page.addScriptTag({path:'node_modules/livekit-client/dist/livekit-client.umd.js'});}
  timer=setInterval(()=>{if(pending)return;pending=true;void Promise.all(grants.map(g=>g.ctx.request.post(`${base}/${call}/connections/${g.grantId}/heartbeat`,{headers,data:{roomId:g.roomId,roomVersion:g.roomVersion}}))).finally(()=>{pending=false;});},5000);
  for(let n=0;n<32;n++){
   const ctx=contexts[n%2],joined=await ctx.request.post(`${base}/${call}/join`,{headers,data:{clientId:randomUUID(),recordingConsent:false}});expect(joined.status()).toBe(200);const g=await joined.json();grants.push({ctx,...g});
   await pages[n%2].evaluate(async grant=>{const w=window as unknown as {LivekitClient:typeof LiveKit;capacityRooms:LiveKit.Room[];capacitySource:MediaStream};w.capacityRooms??=[];w.capacitySource??=await navigator.mediaDevices.getUserMedia({audio:true});const r=new w.LivekitClient.Room();await r.connect(grant.url,grant.token);await r.localParticipant.publishTrack(w.capacitySource.getAudioTracks()[0].clone(),{source:w.LivekitClient.Track.Source.Microphone});w.capacityRooms.push(r);},g);
  }
  expect((await contexts[0].request.post(`${base}/${call}/join`,{headers,data:{clientId:randomUUID(),recordingConsent:false}})).status()).toBe(409);
  const sample=async()=>Promise.all(pages.map(p=>p.evaluate(async()=>{const w=window as unknown as {capacityRooms:LiveKit.Room[]};return Promise.all(w.capacityRooms.map(async r=>{let received=0;for(const participant of r.remoteParticipants.values())for(const publication of participant.audioTrackPublications.values())(await publication.track?.getRTCStatsReport())?.forEach(s=>{if(s.type==='inbound-rtp')received+=Number(s.bytesReceived??0);});return {state:r.state,remote:r.remoteParticipants.size,audioReceived:received};}));})));
  await expect.poll(async()=>(await sample()).flat().filter(r=>r.state==='connected'&&r.remote===31&&r.audioReceived>0).length,{timeout:45000}).toBe(32);
  await writeFile('docs/evidence/media-capacity-0.1.127.json',JSON.stringify({recordedAt:new Date().toISOString(),scope:'32 SDK device sessions, two authenticated users, synthetic microphone sources, real loopback SFU; no UI, video, external-network or production performance claim',devices:(await sample()).flat(),nextDeviceStatus:409},null,2)+'\n');
 }finally{clearInterval(timer);if(call)await contexts[0].request.post(`${base}/${call}/end`,{headers,data:{}});for(const p of pages)await p.evaluate(async()=>{const w=window as unknown as {capacityRooms?:LiveKit.Room[];capacitySource?:MediaStream};await Promise.all(w.capacityRooms?.map(r=>r.disconnect())??[]);w.capacitySource?.getTracks().forEach(t=>t.stop());}).catch(()=>{});await browser.close();}
});
