import {AccessToken,EgressClient,RoomServiceClient,TrackSource} from 'livekit-server-sdk';
import path from 'node:path';
import {z} from 'zod';
export function meetingLimits(env:Partial<NodeJS.ProcessEnv>=process.env){return {participants:z.coerce.number().int().min(2).max(32).parse(env.MEDIA_PARTICIPANT_LIMIT??32),invitations:z.coerce.number().int().min(2).max(100).parse(env.MEDIA_INVITATION_LIMIT??100),calls:z.coerce.number().int().min(1).max(32).parse(env.MEDIA_ACTIVE_CALL_LIMIT??32)};}
export function mediaConfiguration(env:NodeJS.ProcessEnv=process.env){
  meetingLimits(env);
  const keys=['LIVEKIT_URL','LIVEKIT_API_URL','LIVEKIT_API_KEY','LIVEKIT_API_SECRET'];
  if(!keys.some(key=>env[key]))return null;
  if(keys.some(key=>!env[key]?.trim()))throw new Error('LiveKit configuration is incomplete');
  const browser=new URL(env.LIVEKIT_URL!),api=new URL(env.LIVEKIT_API_URL!);
  const local=env.NODE_ENV!=='production'&&env.LIVEKIT_ALLOW_INSECURE_LOCAL==='true';
  if(!['wss:',...(local?['ws:']:[])].includes(browser.protocol)||!['https:',...(local?['http:']:[])].includes(api.protocol)||[browser,api].some(url=>url.username||url.password||url.search||url.hash))throw new Error('LiveKit requires secure URLs without credentials, query or fragment');
  if(env.LIVEKIT_API_SECRET!.length<32)throw new Error('LiveKit secret must contain at least32 characters');
  if(env.NODE_ENV==='production'&&(env.LIVEKIT_API_KEY!.startsWith('local-')||env.LIVEKIT_API_SECRET!.startsWith('local-')))throw new Error('Local media credentials are forbidden in production');
  return {url:browser.toString(),api:api.toString(),key:env.LIVEKIT_API_KEY!,secret:env.LIVEKIT_API_SECRET!,recordingsRoot:path.resolve(env.MEDIA_RECORDINGS_ROOT??'.data/media-recordings'),recording:env.LIVEKIT_RECORDING_ENABLED==='true',egressHealth:env.LIVEKIT_EGRESS_HEALTH_URL};
}
export function mediaClients(){
  const c=mediaConfiguration();if(!c)throw new Error('Media service is not configured');
  return {configuration:c,rooms:new RoomServiceClient(c.api,c.key,c.secret,{requestTimeout:5}),egress:new EgressClient(c.api,c.key,c.secret,{requestTimeout:15})};
}
export const mediaRoomName=(roomId:string)=>`cc-${roomId}`;
export async function mediaToken(identity:string,name:string,roomId:string,roomVersion:string){
  const c=mediaConfiguration();if(!c)throw new Error('Media service is not configured');
  const token=new AccessToken(c.key,c.secret,{identity,name,ttl:15});
  token.addGrant({room:mediaRoomName(roomVersion),roomJoin:true,canPublish:true,canSubscribe:true,canPublishData:false,canUpdateOwnMetadata:false,canPublishSources:[TrackSource.CAMERA,TrackSource.MICROPHONE]});
  return {url:c.url,token:await token.toJwt(),identity,roomId,roomVersion};
}
