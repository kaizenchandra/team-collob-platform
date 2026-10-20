import type {FastifyInstance,FastifyRequest} from 'fastify';
import {randomUUID} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {realpath,stat} from 'node:fs/promises';
import path from 'node:path';
import {z} from 'zod';
import {EncodedFileOutput,EncodedFileType,EncodingOptionsPreset,type EgressInfo} from 'livekit-server-sdk';
import {pool,transaction,type DB} from './db.ts';
import {accessSQL,audit,channel,event,hash,HttpError} from './security.ts';
import {requirePosting} from './posting-policy.ts';
import {idParam} from './server.ts';
import {meetingLimits,mediaClients,mediaConfiguration,mediaRoomName,mediaToken} from './media-config.ts';
import {registerMeetingProtocol,reconcileMeetingProtocol,provisionMediaRoom,retireMediaCredentials} from './meeting-protocol.ts';
import {sessionReader} from './session-policy.ts';

export type Call={id:string;org_id:string;channel_id:string;host_user_id:string;ended_at:Date|null;created_at:Date;archived:boolean;mode:"audio"|"video";caller_user_id:string;ring_until:Date;end_reason:string|null};
export type Grant={id:string;call_id:string;room_id:string;user_id:string;client_id:string;session_hash:string;recording_consent:boolean;provider_room:string;hand_raised_at:Date|null;expires_at:Date;revoked_at:Date|null};
type Recording={id:string;call_id:string;room_id:string;status:string;provider_room:string;egress_id:string|null;org_id:string;created_at:Date};
const uuid=z.uuid(),empty=z.object({}).strict(),activeRecording="('starting','active','stopping','uncertain')";
export const cookieHash=(req:FastifyRequest)=>hash(req.headers.cookie?.split(';').map(p=>p.trim()).find(p=>p.startsWith('concord_session='))?.slice(16)??'');
const recordingPath=(org:string,call:string,id:string)=>path.join(mediaConfiguration()!.recordingsRoot,uuid.parse(org),uuid.parse(call),uuid.parse(id)+'.mp4');
export async function callAccess(db:DB,user:string,org:string,id:string,lock=false){
  const row=(await db.query<Call>(`SELECT x.*,c.archived FROM media_calls x JOIN channels c ON c.id=x.channel_id WHERE x.id=$3 AND x.org_id=$2 AND c.org_id=$2 AND ${accessSQL} ${lock?'FOR NO KEY UPDATE OF x,c':''}`,[user,org,id])).rows[0];
  if(!row)throw new HttpError(404,'Call unavailable');return row;
}
export function host(call:Call,user:string){if(call.host_user_id!==user)throw new HttpError(403,'Only the call host can perform this action');}
export function active(call:Call){if(call.ended_at||call.archived)throw new HttpError(409,'This call has ended or its conversation is archived');}
function configured(){const c=mediaConfiguration();if(!c)throw new HttpError(503,'Configure LiveKit on the server before using media');return c;}
async function roomExists(db:DB,call:string,room:string){if(!(await db.query('SELECT id FROM media_rooms WHERE call_id=$1 AND id=$2 AND closed_at IS NULL',[call,room])).rowCount)throw new HttpError(404,'Breakout room unavailable');}
async function requireConsent(db:DB,room:string,consent:boolean){if(!consent&&(await db.query(`SELECT id FROM media_recordings WHERE room_id=$1 AND status IN ${activeRecording}`,[room])).rowCount)throw new HttpError(409,'Recording is in progress or being reconciled. Consent before joining this room.');}
async function removeIdentity(room:string,identity:string){try{const physical=(await pool.query('SELECT provider_room FROM media_rooms WHERE id=$1',[room])).rows[0]?.provider_room;if(physical)await mediaClients().rooms.removeParticipant(mediaRoomName(physical),identity);}catch{/* Durable lease reconciliation repeats removal, including after an ambiguous provider response. */}}
export async function grantFor(req:FastifyRequest,db:DB,call:Call){
  const grant=(await db.query<Grant>('SELECT g.*,r.provider_room FROM media_grants g JOIN media_rooms r ON r.id=g.room_id WHERE g.call_id=$1 AND g.id=$2 AND g.user_id=$3 AND g.session_hash=$4 AND g.revoked_at IS NULL FOR UPDATE OF g',[call.id,idParam(req,'grant'),req.user.id,cookieHash(req)])).rows[0];
  if(!grant)throw new HttpError(404,'Call connection unavailable');return grant;
}
export async function collaborationGrant(req:FastifyRequest,db:DB){
  const call=await callAccess(db,req.user.id,idParam(req),idParam(req,'call'),true);active(call);const grant=await grantFor(req,db,call);
  if(grant.expires_at.getTime()<=Date.now()||(await db.query('SELECT 1 FROM media_bans WHERE call_id=$1 AND user_id=$2',[call.id,req.user.id])).rowCount)throw new HttpError(403,'Call connection expired or was removed');
  await roomExists(db,call.id,grant.room_id);return {call,grant};
}
async function syncRecording(row:Recording,info:EgressInfo){
  const states=['starting','active','stopping','complete','failed','failed','complete'];const status=states[info.status]??'uncertain';
  const file=info.fileResults.find(f=>f.filename===recordingPath(row.org_id,row.call_id,row.id));
  await pool.query('UPDATE media_recordings SET egress_id=$2,status=$3,finished_at=CASE WHEN $3 IN(\'complete\',\'failed\') THEN now() ELSE NULL END,bytes=$4,error_code=$5 WHERE id=$1 AND status NOT IN(\'complete\',\'failed\')',[row.id,info.egressId,status,file?String(file.size):null,info.error?'provider_recording_failed':null]);
}
export async function reconcileMedia(){
  const {rooms,egress}=mediaClients();
  const providerRooms=(await rooms.listRooms()).filter(room=>/^cc-[0-9a-f-]{36}$/.test(room.name));
  let known:Map<string,{call:Call;room:string}>,grants:Map<string,Grant>;
  try{
    await reconcileMeetingProtocol();
    const roomRows=(await pool.query(`SELECT x.*,c.archived,r.id room_id,r.provider_room,r.closed_at FROM media_rooms r JOIN media_calls x ON x.id=r.call_id JOIN channels c ON c.id=x.channel_id WHERE x.ended_at IS NULL AND r.closed_at IS NULL`)).rows;
    known=new Map(roomRows.map(row=>[mediaRoomName(row.provider_room),{call:row,room:row.room_id}]));
    const live=(await pool.query<Grant>(`SELECT g.* FROM media_grants g JOIN media_calls x ON x.id=g.call_id JOIN channels c ON c.id=x.channel_id
      WHERE g.revoked_at IS NULL AND g.expires_at>now() AND x.ended_at IS NULL AND NOT c.archived
      AND NOT EXISTS(SELECT 1 FROM media_bans b WHERE b.call_id=x.id AND b.user_id=g.user_id)
      AND EXISTS(SELECT 1 FROM memberships m WHERE m.org_id=x.org_id AND m.user_id=g.user_id AND m.active)
      AND (c.kind='standard' AND EXISTS(SELECT 1 FROM team_members t WHERE t.team_id=c.team_id AND t.user_id=g.user_id)
        OR c.kind<>'standard' AND EXISTS(SELECT 1 FROM channel_members cm WHERE cm.channel_id=c.id AND cm.user_id=g.user_id))`)).rows;
    const readSession=sessionReader();
    const valid=await Promise.all(live.map(async g=>{try{return (await readSession(g.session_hash)).rowCount?g:null;}catch{return null;}}));
    grants=new Map(valid.filter((g):g is Grant=>g!==null).map(g=>[g.id,g]));
  }catch{
    // Failure to validate permissions must not leave an existing media room open indefinitely.
    await Promise.allSettled(providerRooms.map(room=>rooms.deleteRoom(room.name)));throw new Error('Media authorization unavailable');
  }
  const recordings=(await pool.query<Recording>(`SELECT r.*,x.org_id FROM media_recordings r JOIN media_calls x ON x.id=r.call_id WHERE r.status IN ${activeRecording} ORDER BY r.created_at LIMIT 100`)).rows;
  await Promise.all(providerRooms.map(async room=>{
    const current=known.get(room.name);
    if(!current||current.call.archived){await rooms.deleteRoom(room.name);return;}
    const participants=await rooms.listParticipants(room.name);
    await Promise.all(participants.map(async p=>{
      if(p.kind===2&&recordings.some(r=>r.room_id===current.room))return;
      const grant=grants.get(p.identity);
      if(!grant||grant.room_id!==current.room)await rooms.removeParticipant(room.name,p.identity).catch(()=>{});
    }));
  }));
  for(const row of recordings){
    const matches=await egress.listEgress(row.egress_id?{egressId:row.egress_id}:{roomName:mediaRoomName(row.provider_room)});
    const info=matches.find(info=>info.egressId===row.egress_id||JSON.stringify(info.toJson()).includes(recordingPath(row.org_id,row.call_id,row.id)));
    if(info){await syncRecording(row,info);const call=(await pool.query('SELECT x.ended_at,c.archived,r.closed_at FROM media_calls x JOIN channels c ON c.id=x.channel_id JOIN media_rooms r ON r.call_id=x.id WHERE x.id=$1 AND r.id=$2',[row.call_id,row.room_id])).rows[0];if((!call||call.ended_at||call.archived||call.closed_at)&&info.status<2)await egress.stopEgress(info.egressId);}
    else if(Date.now()-new Date(row.created_at).getTime()>60000)await pool.query("UPDATE media_recordings SET status='uncertain',error_code='provider_acknowledgement_unconfirmed' WHERE id=$1 AND status NOT IN('complete','failed')",[row.id]);
  }
  const expired=(await pool.query("SELECT x.id FROM media_calls x WHERE x.ended_at IS NULL AND x.ring_until<=now() AND EXISTS(SELECT 1 FROM media_invitations i WHERE i.call_id=x.id AND i.response='pending') LIMIT 100")).rows;
  for(const row of expired)await transaction(async db=>{
    const call=(await db.query('SELECT x.*,c.kind FROM media_calls x JOIN channels c ON c.id=x.channel_id WHERE x.id=$1 FOR NO KEY UPDATE OF x,c',[row.id])).rows[0];if(!call||call.ended_at||call.ring_until.getTime()>Date.now())return;
    await db.query("UPDATE media_invitations SET response='missed',responded_at=now() WHERE call_id=$1 AND response='pending'",[call.id]);
    if(call.kind==='direct'&&!(await db.query("SELECT 1 FROM media_invitations WHERE call_id=$1 AND user_id<>$2 AND response='accepted'",[call.id,call.caller_user_id])).rowCount){await db.query("UPDATE media_calls SET ended_at=now(),end_reason='missed' WHERE id=$1",[call.id]);await db.query('UPDATE media_grants SET revoked_at=now() WHERE call_id=$1',[call.id]);}
  });
  await pool.query(`UPDATE media_calls x SET ended_at=now(),end_reason=CASE WHEN x.created_at<now()-interval '24 hours' THEN 'max_duration' ELSE 'empty' END WHERE x.ended_at IS NULL AND (x.created_at<now()-interval '24 hours' OR (x.created_at<now()-interval '2 minutes' AND NOT EXISTS(SELECT 1 FROM media_grants g WHERE g.call_id=x.id AND g.revoked_at IS NULL AND g.expires_at>now())))`);
  await pool.query("UPDATE media_invitations i SET response=CASE WHEN x.ring_until<=now() THEN 'missed' ELSE 'cancelled' END,responded_at=now() FROM media_calls x WHERE i.call_id=x.id AND i.response='pending' AND x.ended_at IS NOT NULL");
}

export async function registerMedia(app:FastifyInstance,readAuth?:ReturnType<typeof sessionReader>){
  await registerMeetingProtocol(app,readAuth);
  let running=false,lastSuccess=0;
  const tick=async()=>{if(running)return;running=true;try{await reconcileMedia();lastSuccess=Date.now();}catch{app.log.warn('Media reconciliation unavailable');}finally{running=false;}};
  if(mediaConfiguration()){void tick();const timer=setInterval(()=>void tick(),2000);timer.unref();app.addHook('onClose',async()=>clearInterval(timer));}
  app.get('/v1/organizations/:id/media',async req=>{
    const org=idParam(req);if(!(await pool.query('SELECT 1 FROM memberships WHERE user_id=$1 AND org_id=$2 AND active',[req.user.id,org])).rowCount)throw new HttpError(404,'Workspace unavailable');
    const config=mediaConfiguration();if(!config)return {state:'unconfigured',recording:false,independentDevicesVerified:false};
    let reachable=false,recording=false;try{await mediaClients().rooms.listRooms();reachable=true;if(config.recording&&config.egressHealth)recording=(await fetch(config.egressHealth,{signal:AbortSignal.timeout(3000)})).ok;}catch{/* Return honest service state without leaking transport credentials. */}
    return {state:reachable&&lastSuccess>Date.now()-15000?'ready':'unavailable',recording,independentDevicesVerified:false,leaseSeconds:25,tokenSeconds:15};
  });
  app.get('/v1/organizations/:id/calls/incoming',async req=>{
    const org=idParam(req);empty.parse(req.query);if(!(await pool.query('SELECT 1 FROM memberships WHERE user_id=$1 AND org_id=$2 AND active',[req.user.id,org])).rowCount)throw new HttpError(404,'Workspace unavailable');
    const calls=(await pool.query(`SELECT x.id,x.channel_id,c.name channel_name,x.mode,x.ring_until,u.name caller_name FROM media_invitations i JOIN media_calls x ON x.id=i.call_id JOIN channels c ON c.id=x.channel_id JOIN users u ON u.id=x.caller_user_id WHERE i.user_id=$1 AND x.org_id=$2 AND i.response='pending' AND x.ended_at IS NULL AND x.ring_until>now() AND NOT c.archived AND ${accessSQL} AND NOT EXISTS(SELECT 1 FROM media_bans b WHERE b.call_id=x.id AND b.user_id=$1) ORDER BY x.created_at DESC LIMIT 10`,[req.user.id,org])).rows;return {calls};
  });
  app.post('/v1/organizations/:id/calls/:call/respond',async req=>{
    const body=z.object({response:z.enum(['accepted','declined']),clientId:uuid.optional()}).strict().parse(req.body);
    await transaction(async db=>{await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,126))',[req.user.id]);const call=await callAccess(db,req.user.id,idParam(req),idParam(req,'call'),true);active(call);const invitation=(await db.query('SELECT response,accepted_session,accepted_device FROM media_invitations WHERE call_id=$1 AND user_id=$2',[call.id,req.user.id])).rows[0];if(!invitation)throw new HttpError(404,'Call invitation unavailable');if(invitation.response===body.response){if(body.response==='accepted'&&invitation.accepted_session&&(invitation.accepted_session!==cookieHash(req)||invitation.accepted_device&&invitation.accepted_device!==body.clientId))throw new HttpError(409,'This call was answered on another device');return;}if(invitation.response!=='pending'||call.ring_until.getTime()<=Date.now())throw new HttpError(409,'This invitation has already been answered or expired');
      if((await db.query('SELECT 1 FROM media_bans WHERE call_id=$1 AND user_id=$2',[call.id,req.user.id])).rowCount)throw new HttpError(403,'You were removed from this call');
      if(body.response==='accepted'&&(await db.query('SELECT 1 FROM media_grants g JOIN media_calls x ON x.id=g.call_id WHERE g.user_id=$1 AND g.call_id<>$2 AND g.revoked_at IS NULL AND g.expires_at>now() AND x.ended_at IS NULL',[req.user.id,call.id])).rowCount)throw new HttpError(409,'Busy: leave your other call before answering');
      await db.query(`UPDATE media_invitations SET response=$3,responded_at=now(),accepted_session=CASE WHEN $3='accepted' THEN $4 ELSE NULL END,accepted_device=$5 WHERE call_id=$1 AND user_id=$2`,[call.id,req.user.id,body.response,cookieHash(req),body.clientId??null]);
      if(body.response==='declined'&&(await db.query("SELECT 1 FROM channels WHERE id=$1 AND kind='direct'",[call.channel_id])).rowCount){await db.query("UPDATE media_calls SET ended_at=now(),end_reason='declined' WHERE id=$1",[call.id]);await db.query('UPDATE media_grants SET revoked_at=now() WHERE call_id=$1',[call.id]);}
      await audit(db,req.user.id,call.org_id,'media.invitation.'+body.response,call.id);
    });return {ok:true};
  });
  app.post('/v1/organizations/:id/calls/:call/connections/:grant/hand',async req=>{
    const body=z.object({raised:z.boolean()}).strict().parse(req.body);await transaction(async db=>{const {grant}=await collaborationGrant(req,db);await db.query(`UPDATE media_grants SET hand_order=CASE WHEN $2 THEN coalesce(hand_order,nextval('media_hand_sequence')) ELSE NULL END,hand_raised_at=CASE WHEN $2 THEN coalesce(hand_raised_at,now()) ELSE NULL END WHERE id=$1`,[grant.id,body.raised]);});return {ok:true};
  });
  app.get('/v1/organizations/:id/calls/:call/connections/:grant/chat',async req=>{
    return transaction(async db=>{const {grant}=await collaborationGrant(req,db);const q=z.object({before:z.string().regex(/^[1-9]\d{0,18}$/).refine(s=>BigInt(s)<=BigInt('9223372036854775807')).optional()}).strict().parse(req.query);const rows=(await db.query('SELECT m.id,m.seq::text,m.user_id,m.body,m.created_at,u.name FROM media_messages m JOIN users u ON u.id=m.user_id WHERE m.call_id=$1 AND m.room_id=$2 AND ($3::bigint IS NULL OR m.seq<$3) ORDER BY m.seq DESC LIMIT 101',[grant.call_id,grant.room_id,q.before??null])).rows;const unread=Number((await db.query('SELECT count(*) FROM media_messages WHERE room_id=$1 AND user_id<>$2 AND seq>coalesce((SELECT last_seq FROM media_chat_reads WHERE room_id=$1 AND user_id=$2),0)',[grant.room_id,req.user.id])).rows[0].count);return {roomId:grant.room_id,messages:rows.slice(0,100).reverse(),hasMore:rows.length>100,nextCursor:rows.length>100?rows[99].seq:null,unread};});
  });
  app.post('/v1/organizations/:id/calls/:call/connections/:grant/chat',async req=>{
    const body=z.object({roomId:uuid,clientId:uuid,body:z.string().trim().min(1).max(4000)}).strict().parse(req.body);return transaction(async db=>{const {call,grant}=await collaborationGrant(req,db);if(grant.room_id!==body.roomId)throw new HttpError(409,'Your call room changed. Review the message in the new room.');const old=(await db.query('SELECT id,body,room_id FROM media_messages WHERE call_id=$1 AND user_id=$2 AND client_id=$3',[call.id,req.user.id,body.clientId])).rows[0];if(old){if(old.body!==body.body||old.room_id!==grant.room_id)throw new HttpError(409,'This send identity belongs to another message or room');return {id:old.id};}
      if(Number((await db.query("SELECT count(*) FROM media_messages WHERE call_id=$1 AND user_id=$2 AND created_at>now()-interval '10 seconds'",[call.id,req.user.id])).rows[0].count)>=10)throw new HttpError(429,'Wait a few seconds before sending more call messages');
      if(Number((await db.query('SELECT count(*) FROM media_messages WHERE call_id=$1',[call.id])).rows[0].count)>=10000)throw new HttpError(409,'The call chat limit has been reached');
      const id=randomUUID();await db.query('INSERT INTO media_messages(id,call_id,room_id,user_id,client_id,body) VALUES($1,$2,$3,$4,$5,$6)',[id,call.id,grant.room_id,req.user.id,body.clientId,body.body]);return {id};});
  });
  app.get('/v1/organizations/:id/calls',async req=>{
    const org=idParam(req);empty.parse(req.query);
    const calls=(await pool.query(`SELECT x.id,x.channel_id,c.name channel_name,x.host_user_id,u.name host_name,x.created_at,x.ended_at,x.mode,x.end_reason,(SELECT response FROM media_invitations i WHERE i.call_id=x.id AND i.user_id=$1) response,(SELECT count(*)::int FROM media_grants g WHERE g.call_id=x.id AND g.revoked_at IS NULL AND g.expires_at>now()) participants FROM media_calls x JOIN channels c ON c.id=x.channel_id JOIN users u ON u.id=x.host_user_id WHERE x.org_id=$2 AND ${accessSQL} ORDER BY (x.ended_at IS NULL) DESC,x.created_at DESC LIMIT 50`,[req.user.id,org])).rows;
    if(!(await pool.query('SELECT 1 FROM memberships WHERE user_id=$1 AND org_id=$2 AND active',[req.user.id,org])).rowCount)throw new HttpError(404,'Workspace unavailable');return {calls};
  });
  app.post('/v1/organizations/:id/channels/:channel/calls',async req=>{
    configured();const org=idParam(req),channelId=idParam(req,'channel'),body=z.object({clientId:uuid,mode:z.enum(['audio','video']).default('video')}).strict().parse(req.body);
    return transaction(async db=>{const c=await channel(db,req.user.id,channelId,true);if(c.org_id!==org)throw new HttpError(404,'Conversation unavailable');if(c.archived)throw new HttpError(409,'This conversation is archived');await requirePosting(db,req.user.id,c);
      const old=(await db.query('SELECT id FROM media_calls WHERE channel_id=$1 AND (ended_at IS NULL OR client_id=$2) ORDER BY (ended_at IS NULL) DESC LIMIT 1',[channelId,body.clientId])).rows[0];if(old)return {id:old.id};
      await db.query('SELECT pg_advisory_xact_lock(712399)');
      if(Number((await db.query('SELECT count(*) FROM media_calls WHERE ended_at IS NULL')).rows[0].count)>=meetingLimits().calls)throw new HttpError(409,'The deployment call limit has been reached');
      const id=randomUUID();await db.query(`INSERT INTO media_calls(id,org_id,channel_id,host_user_id,caller_user_id,client_id,mode,ring_until) VALUES($1,$2,$3,$4,$4,$5,$6,now()+interval '45 seconds')`,[id,org,channelId,req.user.id,body.clientId,body.mode]);await db.query("INSERT INTO media_rooms(id,call_id,name,client_id,is_main) VALUES($1,$1,'Main room',$1,true)",[id]);const recipients=(await db.query(`SELECT u.id FROM users u JOIN memberships m ON m.user_id=u.id AND m.org_id=$1 JOIN channels c ON c.id=$2 WHERE m.active AND NOT u.disabled AND ${accessSQL.replaceAll('$1','u.id')} ORDER BY u.id LIMIT 101`,[org,channelId])).rows;
      if(recipients.length>meetingLimits().invitations)throw new HttpError(409,'Call invitations support up to100 conversation members');
      for(const person of recipients)await db.query("INSERT INTO media_invitations(call_id,user_id,response,responded_at) VALUES($1,$2,$3,CASE WHEN $3='accepted' THEN now() ELSE NULL END)",[id,person.id,person.id===req.user.id?'accepted':(await db.query('SELECT 1 FROM media_grants g JOIN media_calls x ON x.id=g.call_id WHERE g.user_id=$1 AND g.revoked_at IS NULL AND g.expires_at>now() AND x.ended_at IS NULL',[person.id])).rowCount?'busy':'pending']);
      if(c.kind==='direct'&&!(await db.query("SELECT 1 FROM media_invitations WHERE call_id=$1 AND user_id<>$2 AND response='pending'",[id,req.user.id])).rowCount)await db.query("UPDATE media_calls SET ended_at=now(),end_reason=CASE WHEN EXISTS(SELECT 1 FROM media_invitations WHERE call_id=$1 AND response='busy') THEN 'busy' ELSE 'unavailable' END WHERE id=$1",[id]);
      await audit(db,req.user.id,org,'media.call.started',id);await event(db,org,channelId,'media.changed',{callId:id});return {id};});
  });
  app.get('/v1/organizations/:id/calls/:call',async req=>{
    const call=await callAccess(pool,req.user.id,idParam(req),idParam(req,'call'));empty.parse(req.query);
    const rooms=(await pool.query('SELECT id,name,is_main,closed_at FROM media_rooms WHERE call_id=$1 ORDER BY is_main DESC,id',[call.id])).rows;
    const participants=(await pool.query('SELECT g.id,g.user_id,g.room_id,g.recording_consent,g.hand_raised_at,g.hand_order::text,g.connected_at,g.disconnected_at,g.unmute_requested_at,u.name FROM media_grants g JOIN users u ON u.id=g.user_id WHERE g.call_id=$1 AND g.revoked_at IS NULL AND g.expires_at>now() ORDER BY g.joined_at LIMIT 64',[call.id])).rows;
    const recordings=(await pool.query('SELECT id,room_id,status,created_at,finished_at,bytes,error_code FROM media_recordings WHERE call_id=$1 ORDER BY created_at DESC LIMIT 50',[call.id])).rows;
    const invitations=(await pool.query('SELECT i.user_id,i.response,u.name FROM media_invitations i JOIN users u ON u.id=i.user_id WHERE i.call_id=$1 ORDER BY i.invited_at,i.user_id LIMIT 100',[call.id])).rows;
    return {call:{id:call.id,hostUserId:call.host_user_id,endedAt:call.ended_at,channelId:call.channel_id,mode:call.mode,callerUserId:call.caller_user_id,ringUntil:call.ring_until,endReason:call.end_reason},rooms,participants,recordings,invitations};
  });
  app.post('/v1/organizations/:id/calls/:call/join',async req=>{
    configured();const b=z.object({clientId:uuid,recordingConsent:z.boolean()}).strict().parse(req.body);
    const grant=await transaction(async db=>{await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,126))',[req.user.id]);const call=await callAccess(db,req.user.id,idParam(req),idParam(req,'call'),true);active(call);
      if((await db.query('SELECT 1 FROM media_grants g JOIN media_calls x ON x.id=g.call_id WHERE g.user_id=$1 AND g.call_id<>$2 AND g.revoked_at IS NULL AND g.expires_at>now() AND x.ended_at IS NULL',[req.user.id,call.id])).rowCount)throw new HttpError(409,'Busy: leave your other call before joining');
      if((await db.query('SELECT 1 FROM media_bans WHERE call_id=$1 AND user_id=$2',[call.id,req.user.id])).rowCount)throw new HttpError(403,'You were removed from this call');
      let g:Grant|undefined=(await db.query<Grant>('SELECT * FROM media_grants WHERE call_id=$1 AND user_id=$2 AND client_id=$3 AND revoked_at IS NULL FOR UPDATE',[call.id,req.user.id,b.clientId])).rows[0];
      if(g&&g.expires_at.getTime()<Date.now()){await db.query('UPDATE media_grants SET revoked_at=now() WHERE id=$1',[g.id]);g=undefined;}const room=g?.room_id??call.id;await roomExists(db,call.id,room);await requireConsent(db,room,b.recordingConsent);
      if(g&&g.session_hash!==cookieHash(req))throw new HttpError(409,'This connection belongs to another session');
      if(!g&&Number((await db.query('SELECT count(*) FROM media_grants WHERE call_id=$1 AND revoked_at IS NULL AND expires_at>now()',[call.id])).rows[0].count)>=meetingLimits().participants)throw new HttpError(409,'This call is full');
      if(g)g=(await db.query<Grant>("UPDATE media_grants SET expires_at=now()+interval '25 seconds',recording_consent=$2 WHERE id=$1 RETURNING *",[g.id,b.recordingConsent])).rows[0];
      else g=(await db.query<Grant>("INSERT INTO media_grants(id,call_id,room_id,user_id,client_id,session_hash,recording_consent,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '25 seconds') RETURNING *",[randomUUID(),call.id,room,req.user.id,b.clientId,cookieHash(req),b.recordingConsent])).rows[0];await db.query("INSERT INTO media_invitations(call_id,user_id,response,responded_at) VALUES($1,$2,'accepted',now()) ON CONFLICT(call_id,user_id) DO UPDATE SET response='accepted',responded_at=coalesce(media_invitations.responded_at,now())",[call.id,req.user.id]);return {...g,provider_room:(await db.query('SELECT provider_room FROM media_rooms WHERE id=$1',[room])).rows[0].provider_room};});
    await provisionMediaRoom(grant.room_id,grant.provider_room);return {grantId:grant.id,...await mediaToken(grant.id,req.user.name,grant.room_id,grant.provider_room)};
  });
  app.post('/v1/organizations/:id/calls/:call/connections/:grant/heartbeat',async req=>{
    configured();const b=z.object({roomId:uuid,roomVersion:uuid}).strict().parse(req.body);
    if((await pool.query('SELECT 1 FROM media_bans WHERE call_id=$1 AND user_id=$2',[idParam(req,'call'),req.user.id])).rowCount)throw new HttpError(403,'You were removed from this meeting');
    const g=await transaction(async db=>{const call=await callAccess(db,req.user.id,idParam(req),idParam(req,'call'),true);active(call);const grant=await grantFor(req,db,call);
      if(grant.expires_at.getTime()<Date.now()||(await db.query('SELECT 1 FROM media_bans WHERE call_id=$1 AND user_id=$2',[call.id,req.user.id])).rowCount)throw new HttpError(403,'Call connection expired or was removed');
      await requireConsent(db,grant.room_id,grant.recording_consent);await db.query("UPDATE media_grants SET expires_at=now()+interval '25 seconds' WHERE id=$1",[grant.id]);await db.query("UPDATE media_shares SET expires_at=now()+interval '25 seconds' WHERE grant_id=$1 AND room_id=$2",[grant.id,grant.room_id]);return grant;});
    return {ok:true,roomId:g.room_id,roomVersion:g.provider_room,...(b.roomId!==g.room_id||b.roomVersion!==g.provider_room?(await provisionMediaRoom(g.room_id,g.provider_room),await mediaToken(g.id,req.user.name,g.room_id,g.provider_room)): {})};
  });
  app.delete('/v1/organizations/:id/calls/:call/connections/:grant',async req=>{
    const g=await transaction(async db=>{const call=await callAccess(db,req.user.id,idParam(req),idParam(req,'call'),true);const grant=(await db.query<Grant>('SELECT * FROM media_grants WHERE id=$1 AND call_id=$2 AND user_id=$3 AND session_hash=$4',[idParam(req,'grant'),call.id,req.user.id,cookieHash(req)])).rows[0];if(!grant)throw new HttpError(404,'Call connection unavailable');await db.query('UPDATE media_grants SET revoked_at=now(),hand_raised_at=NULL,hand_order=NULL WHERE id=$1',[grant.id]);
      const direct=(await db.query("SELECT 1 FROM channels WHERE id=$1 AND kind='direct'",[call.channel_id])).rowCount;
      if(direct&&!(await db.query('SELECT 1 FROM media_grants WHERE call_id=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>now()',[call.id,req.user.id])).rowCount){await db.query("UPDATE media_calls SET ended_at=coalesce(ended_at,now()),end_reason=coalesce(end_reason,CASE WHEN EXISTS(SELECT 1 FROM media_invitations i WHERE i.call_id=media_calls.id AND i.user_id<>media_calls.caller_user_id AND i.response='accepted') THEN 'ended' ELSE 'cancelled' END) WHERE id=$1",[call.id]);await db.query('UPDATE media_grants SET revoked_at=coalesce(revoked_at,now()),hand_raised_at=NULL,hand_order=NULL WHERE call_id=$1',[call.id]);}
      return grant;});await removeIdentity(g.room_id,g.id);return {ok:true};
  });
  app.post('/v1/organizations/:id/calls/:call/end',async req=>{
    empty.parse(req.body);const call=await transaction(async db=>{const c=await callAccess(db,req.user.id,idParam(req),idParam(req,'call'),true);host(c,req.user.id);await db.query(`UPDATE media_calls SET ended_at=coalesce(ended_at,now()),end_reason=coalesce(end_reason,CASE WHEN EXISTS(SELECT 1 FROM media_invitations i WHERE i.call_id=media_calls.id AND i.user_id<>media_calls.caller_user_id AND i.response='accepted') THEN 'ended' ELSE 'cancelled' END) WHERE id=$1`,[c.id]);await db.query('UPDATE media_grants SET revoked_at=coalesce(revoked_at,now()),hand_raised_at=NULL,hand_order=NULL WHERE call_id=$1',[c.id]);await db.query("UPDATE media_invitations SET response='cancelled',responded_at=now() WHERE call_id=$1 AND response='pending'",[c.id]);await audit(db,req.user.id,c.org_id,'media.call.ended',c.id);return c;});
    const rooms=(await pool.query('SELECT provider_room id FROM media_rooms WHERE call_id=$1',[call.id])).rows;if(mediaConfiguration()){const results=await Promise.allSettled([...rooms.map(async r=>mediaClients().rooms.deleteRoom(mediaRoomName(r.id))),retireMediaCredentials(call.id)]);if(results.some(r=>r.status==='rejected'&&(r.reason?.code!=='not_found')))throw new HttpError(503,'Meeting ended; provider disconnect is awaiting reconciliation');}return {ok:true};
  });
  app.post('/v1/organizations/:id/calls/:call/rooms',async req=>{
    configured();const b=z.object({clientId:uuid,name:z.string().trim().min(1).max(80)}).strict().parse(req.body);
    return transaction(async db=>{const call=await callAccess(db,req.user.id,idParam(req),idParam(req,'call'),true);active(call);host(call,req.user.id);const old=(await db.query('SELECT id FROM media_rooms WHERE call_id=$1 AND client_id=$2',[call.id,b.clientId])).rows[0];if(old)return old;
      if(Number((await db.query('SELECT count(*) FROM media_rooms WHERE call_id=$1',[call.id])).rows[0].count)>=9)throw new HttpError(409,'Use up to8 breakout rooms');const id=randomUUID();await db.query('INSERT INTO media_rooms(id,call_id,name,client_id) VALUES($1,$2,$3,$4)',[id,call.id,b.name,b.clientId]);await audit(db,req.user.id,call.org_id,'media.breakout.created',id);return {id};});
  });
  app.post('/v1/organizations/:id/calls/:call/rooms/:room/close',async req=>{
    empty.parse(req.body);configured();const result=await transaction(async db=>{const call=await callAccess(db,req.user.id,idParam(req),idParam(req,'call'),true);active(call);host(call,req.user.id);const room=idParam(req,'room');const current=(await db.query('SELECT id,is_main,closed_at,provider_room FROM media_rooms WHERE call_id=$1 AND id=$2',[call.id,room])).rows[0];if(!current)throw new HttpError(404,'Breakout room unavailable');if(current.is_main)throw new HttpError(400,'End the call to close its main room');if(current.closed_at)return {room,identities:[] as string[]};
      const moving=(await db.query<Grant>('SELECT * FROM media_grants WHERE room_id=$1 AND revoked_at IS NULL AND expires_at>now()',[room])).rows;for(const g of moving)await requireConsent(db,call.id,g.recording_consent);
      await db.query('UPDATE media_grants SET room_id=$2,hand_raised_at=NULL,hand_order=NULL WHERE room_id=$1 AND revoked_at IS NULL',[room,call.id]);await db.query('UPDATE media_rooms SET closed_at=now() WHERE id=$1',[room]);await audit(db,req.user.id,call.org_id,'media.breakout.closed',room);return {room,identities:moving.map(g=>g.id)};});
    await Promise.allSettled(result.identities.map(id=>removeIdentity(result.room,id)));return {ok:true};
  });
  app.post('/v1/organizations/:id/calls/:call/participants/:grant/room',async req=>{
    const b=z.object({roomId:uuid}).strict().parse(req.body);const old=await transaction(async db=>{const c=await callAccess(db,req.user.id,idParam(req),idParam(req,'call'),true);active(c);host(c,req.user.id);await roomExists(db,c.id,b.roomId);const g=(await db.query<Grant>('SELECT * FROM media_grants WHERE call_id=$1 AND id=$2 AND revoked_at IS NULL AND expires_at>now() FOR UPDATE',[c.id,idParam(req,'grant')])).rows[0];if(!g)throw new HttpError(404,'Participant unavailable');await requireConsent(db,b.roomId,g.recording_consent);await db.query('UPDATE media_grants SET room_id=$2,hand_raised_at=NULL,hand_order=NULL WHERE id=$1',[g.id,b.roomId]);return g;});
    if(old.room_id!==b.roomId)await removeIdentity(old.room_id,old.id);return {ok:true};
  });
  app.post('/v1/organizations/:id/calls/:call/participants/:grant/moderate',async req=>{
    const b=z.object({action:z.enum(['mute','remove','lower-hand','request-unmute'])}).strict().parse(req.body);const g=await transaction(async db=>{const c=await callAccess(db,req.user.id,idParam(req),idParam(req,'call'),true);active(c);host(c,req.user.id);const g=(await db.query<Grant>('SELECT * FROM media_grants WHERE call_id=$1 AND id=$2 AND revoked_at IS NULL',[c.id,idParam(req,'grant')])).rows[0];if(!g)throw new HttpError(404,'Participant unavailable');if(g.user_id===req.user.id)throw new HttpError(400,'Use your own call controls');if(b.action==='lower-hand')await db.query('UPDATE media_grants SET hand_raised_at=NULL,hand_order=NULL WHERE id=$1',[g.id]);if(b.action==='request-unmute')await db.query('UPDATE media_grants SET unmute_requested_at=now() WHERE id=$1',[g.id]);if(b.action==='remove'){await db.query('INSERT INTO media_bans VALUES($1,$2) ON CONFLICT DO NOTHING',[c.id,g.user_id]);await db.query('UPDATE media_grants SET revoked_at=now(),hand_raised_at=NULL,hand_order=NULL WHERE call_id=$1 AND user_id=$2',[c.id,g.user_id]);await db.query('DELETE FROM media_shares WHERE room_id IN(SELECT id FROM media_rooms WHERE call_id=$1)',[c.id]);await db.query('UPDATE media_rooms SET provider_room=gen_random_uuid() WHERE call_id=$1',[c.id]);}await audit(db,req.user.id,c.org_id,'media.participant.'+b.action,g.user_id);return g;});
    if(b.action==='remove'){try{await reconcileMedia();}catch{throw new HttpError(503,'Removal saved; media disconnect is awaiting provider recovery. Refresh the meeting status.');}}else if(b.action==='mute'){const client=mediaClients().rooms,physical=(await pool.query('SELECT provider_room FROM media_rooms WHERE id=$1',[g.room_id])).rows[0].provider_room,p=await client.getParticipant(mediaRoomName(physical),g.id);await Promise.all(p.tracks.filter(t=>t.source===2).map(t=>client.mutePublishedTrack(mediaRoomName(physical),g.id,t.sid,true)));}return {ok:true};
  });
  app.post('/v1/organizations/:id/calls/:call/host',async req=>{
    const b=z.object({userId:uuid}).strict().parse(req.body);await transaction(async db=>{const c=await callAccess(db,req.user.id,idParam(req),idParam(req,'call'),true);host(c,req.user.id);active(c);await callAccess(db,b.userId,c.org_id,c.id);if((await db.query('SELECT 1 FROM media_bans WHERE call_id=$1 AND user_id=$2',[c.id,b.userId])).rowCount)throw new HttpError(403,'Participant was removed');if(!(await db.query('SELECT 1 FROM media_grants WHERE call_id=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>now()',[c.id,b.userId])).rowCount)throw new HttpError(404,'Choose a connected participant');await db.query('UPDATE media_calls SET host_user_id=$2 WHERE id=$1',[c.id,b.userId]);await audit(db,req.user.id,c.org_id,'media.host.transferred',b.userId);});return {ok:true};
  });
  app.post('/v1/organizations/:id/calls/:call/rooms/:room/recordings',async req=>{
    const c=configured();if(!c.recording)throw new HttpError(503,'LiveKit Egress recording is not configured');const b=z.object({clientId:uuid}).strict().parse(req.body);
    const row=await transaction(async db=>{const call=await callAccess(db,req.user.id,idParam(req),idParam(req,'call'),true);active(call);host(call,req.user.id);const room=idParam(req,'room');await roomExists(db,call.id,room);
      const old=(await db.query<Recording>('SELECT r.*,$3::uuid org_id FROM media_recordings r WHERE r.call_id=$1 AND r.client_id=$2',[call.id,b.clientId,call.org_id])).rows[0];if(old)return {...old,replayed:true};
      const grants=(await db.query<Grant>('SELECT * FROM media_grants WHERE room_id=$1 AND revoked_at IS NULL AND expires_at>now()',[room])).rows;if(!grants.length||grants.some(g=>!g.recording_consent))throw new HttpError(409,'Every connected participant in this room must consent to recording');
      if((await db.query(`SELECT id FROM media_recordings WHERE room_id=$1 AND status IN ${activeRecording}`,[room])).rowCount)throw new HttpError(409,'A recording is active or awaits reconciliation');const id=randomUUID(),version=randomUUID();await db.query('DELETE FROM media_shares WHERE room_id=$1',[room]);await db.query('UPDATE media_rooms SET provider_room=$2 WHERE id=$1',[room,version]);await db.query("INSERT INTO media_recordings(id,call_id,room_id,requested_by,client_id,status,provider_room) VALUES($1,$2,$3,$4,$5,'starting',$6)",[id,call.id,room,req.user.id,b.clientId,version]);await audit(db,req.user.id,call.org_id,'media.recording.requested',id);return {id,call_id:call.id,room_id:room,org_id:call.org_id,provider_room:version,status:'starting',egress_id:null,created_at:new Date(),replayed:false};});
    if(!row.replayed){try{await provisionMediaRoom(row.room_id,row.provider_room);const info=await mediaClients().egress.startRoomCompositeEgress(mediaRoomName(row.provider_room),new EncodedFileOutput({fileType:EncodedFileType.MP4,filepath:recordingPath(row.org_id,row.call_id,row.id)}),{layout:'grid',encodingOptions:EncodingOptionsPreset.H264_720P_30});await syncRecording(row,info);}catch{await pool.query("UPDATE media_recordings SET status='uncertain',error_code='provider_acknowledgement_unconfirmed' WHERE id=$1",[row.id]);}}
    return {id:row.id};
  });
  app.post('/v1/organizations/:id/calls/:call/recordings/:recording/stop',async req=>{
    empty.parse(req.body);const call=await callAccess(pool,req.user.id,idParam(req),idParam(req,'call'));host(call,req.user.id);const row=(await pool.query<Recording>('SELECT r.*,$3::uuid org_id FROM media_recordings r WHERE r.call_id=$1 AND r.id=$2',[call.id,idParam(req,'recording'),call.org_id])).rows[0];if(!row)throw new HttpError(404,'Recording unavailable');if(['complete','failed'].includes(row.status))return {ok:true};if(!row.egress_id)throw new HttpError(409,'Recording acknowledgement is being reconciled. Refresh before stopping.');
    await pool.query("UPDATE media_recordings SET status='stopping' WHERE id=$1",[row.id]);try{await syncRecording(row,await mediaClients().egress.stopEgress(row.egress_id));}catch{throw new HttpError(503,'Stop acknowledgement unavailable. Refresh recording status; do not start another recording.');}return {ok:true};
  });
  app.get('/v1/organizations/:id/calls/:call/recordings/:recording/download',async(req,reply)=>{
    configured();const call=await callAccess(pool,req.user.id,idParam(req),idParam(req,'call')),id=idParam(req,'recording');const row=(await pool.query('SELECT * FROM media_recordings WHERE id=$1 AND call_id=$2 AND status=\'complete\'',[id,call.id])).rows[0];if(!row)throw new HttpError(404,'Recording is not ready');
    const expected=recordingPath(call.org_id,call.id,id),root=await realpath(mediaConfiguration()!.recordingsRoot),actual=await realpath(expected).catch(()=>{throw new HttpError(404,'Recording file unavailable');});if(!actual.startsWith(root+path.sep))throw new HttpError(404,'Recording file unavailable');const info=await stat(actual);if(!info.isFile()||info.size<=0||info.size>512*1024*1024||row.bytes&&Number(row.bytes)!==info.size)throw new HttpError(404,'Recording integrity check failed');
    let start=0,end=info.size-1;const range=req.headers.range;if(range){const m=/^bytes=(\d+)-(\d*)$/.exec(range);if(!m)throw new HttpError(416,'Invalid recording range');start=Number(m[1]);end=m[2]?Number(m[2]):end;if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||end>=info.size)throw new HttpError(416,'Invalid recording range');reply.code(206).header('Content-Range',`bytes ${start}-${end}/${info.size}`);}
    reply.header('Content-Type','video/mp4').header('Content-Disposition',`attachment; filename="call-${id}.mp4"`).header('Accept-Ranges','bytes').header('Content-Length',end-start+1);return reply.send(createReadStream(actual,{start,end}));
  });
}
