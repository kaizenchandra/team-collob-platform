import {validateAttendees} from './attendee-options.ts';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import {randomUUID} from 'node:crypto';
import {WebhookReceiver,TrackSource} from 'livekit-server-sdk';
import {z} from 'zod';
import {pool,transaction,type DB} from './db.ts';
import {accessSQL,audit,member,HttpError} from './security.ts';
import {idParam} from './server.ts';
import {callAccess,collaborationGrant,cookieHash} from './media.ts';
import {meetingLimits,mediaClients,mediaConfiguration,mediaRoomName} from './media-config.ts';
import {sessionReader} from './session-policy.ts';
const uuid=z.uuid(),empty=z.object({}).strict(),cursor=z.string().regex(/^(0|[1-9]\d{0,18})$/).refine(s=>BigInt(s)<=BigInt('9223372036854775807'));
const sources=(sharing:boolean)=>[TrackSource.CAMERA,TrackSource.MICROPHONE,...(sharing?[TrackSource.SCREEN_SHARE,TrackSource.SCREEN_SHARE_AUDIO]:[])];

// Durable deletion acknowledgements survive process crashes and ambiguous provider responses.
export async function retireMediaCredentials(call?:string){
 const client=mediaClients().rooms;
 for(const row of (await pool.query('SELECT provider_room FROM media_retired_rooms WHERE ($1::uuid IS NULL OR call_id=$1) ORDER BY created_at',[call??null])).rows){
  const name=mediaRoomName(row.provider_room);
  try{await client.deleteRoom(name);}catch{if((await client.listRooms([name])).length)throw new HttpError(503,'Cannot retire stale media credentials; retry when media recovers');}
  await pool.query('DELETE FROM media_retired_rooms WHERE provider_room=$1',[row.provider_room]);
 }
}

export async function provisionMediaRoom(room:string,version:string){
 try{return await provisionRoom(room,version);}catch(e){if(e instanceof HttpError)throw e;throw new HttpError(503,'Media provider unavailable. Retry joining when the service recovers.');}
}
async function provisionRoom(room:string,version:string){
 const clients=mediaClients();
 await retireMediaCredentials();
 // Retired generations are removed before a new generation can accept anyone.
 const retired=(await clients.rooms.listRooms()).filter(r=>/^cc-[0-9a-f-]{36}$/.test(r.name));
 const versions=new Set((await pool.query('SELECT provider_room FROM media_rooms r JOIN media_calls x ON x.id=r.call_id WHERE x.ended_at IS NULL AND r.closed_at IS NULL')).rows.map(r=>mediaRoomName(r.provider_room)));
 for(const r of retired)if(!versions.has(r.name))try{await clients.rooms.deleteRoom(r.name);}catch{if((await clients.rooms.listRooms([r.name])).length)throw new HttpError(503,'Cannot retire stale media credentials; retry when media recovers');}
 await transaction(async db=>{
  const row=(await db.query('SELECT call_id FROM media_rooms WHERE id=$1',[room])).rows[0];
  if(!row||!(await db.query('SELECT id FROM media_calls WHERE id=$1 AND ended_at IS NULL FOR NO KEY UPDATE',[row.call_id])).rowCount)throw new HttpError(409,'This meeting has ended');
  if(!(await db.query('SELECT 1 FROM media_rooms WHERE id=$1 AND provider_room=$2 AND closed_at IS NULL FOR NO KEY UPDATE',[room,version])).rowCount)throw new HttpError(409,'Meeting room changed; refresh authorization');
  // End/removal use the same call lock: a delayed CreateRoom must finish BEFORE they retire it.
  await clients.rooms.createRoom({name:mediaRoomName(version),emptyTimeout:120,departureTimeout:30,maxParticipants:meetingLimits().participants+2});
 });
}

export async function reconcileMeetingProtocol(){
 await pool.query("UPDATE media_grants SET revoked_at=now(),hand_raised_at=NULL,hand_order=NULL WHERE revoked_at IS NULL AND (expires_at<=now() OR disconnected_at<now()-interval '25 seconds' OR (connected_at IS NULL AND joined_at<now()-interval '25 seconds'))");
 // Serialize expiry with claims and heartbeat renewal, including permission RPCs.
 const expired=(await pool.query('SELECT s.room_id,r.call_id FROM media_shares s JOIN media_rooms r ON r.id=s.room_id JOIN media_grants g ON g.id=s.grant_id JOIN media_calls x ON x.id=r.call_id WHERE s.expires_at<=now() OR g.revoked_at IS NOT NULL OR x.ended_at IS NOT NULL')).rows;
 for(const row of expired)await transaction(async db=>{await db.query('SELECT id FROM media_calls WHERE id=$1 FOR NO KEY UPDATE',[row.call_id]);await db.query('DELETE FROM media_shares s USING media_grants g,media_calls x WHERE s.room_id=$1 AND g.id=s.grant_id AND x.id=g.call_id AND (s.expires_at<=now() OR g.revoked_at IS NOT NULL OR x.ended_at IS NOT NULL)',[row.room_id]);});
 await retireMediaCredentials();
 await pool.query("DELETE FROM media_messages WHERE created_at<now()-interval '30 days'");
 await pool.query("DELETE FROM media_changes WHERE created_at<now()-interval '30 days'");
 await pool.query("DELETE FROM media_provider_events WHERE created_at<now()-interval '30 days'");
 const {rooms}=mediaClients();
 const live=(await pool.query('SELECT r.id,r.call_id,r.provider_room,x.ended_at FROM media_rooms r JOIN media_calls x ON x.id=r.call_id WHERE x.ended_at IS NULL AND r.closed_at IS NULL')).rows;
 for(const r of live){
  const found=(await rooms.listRooms([mediaRoomName(r.provider_room)]))[0];const participants=found?await rooms.listParticipants(found.name):[];
  const grants=(await pool.query('SELECT * FROM media_grants WHERE room_id=$1 AND revoked_at IS NULL AND expires_at>now()',[r.id])).rows;
  for(const g of grants){if(!(await sessionReader()(g.session_hash)).rowCount||!(await pool.query(`SELECT 1 FROM channels c WHERE c.id=$2 AND ${accessSQL}`,[g.user_id,(await pool.query('SELECT channel_id FROM media_calls WHERE id=$1',[r.call_id])).rows[0].channel_id])).rowCount)continue;
   const p=participants.find(p=>p.identity===g.id&&p.state===2);
   if(p){
    await pool.query('UPDATE media_grants SET connected_at=coalesce(connected_at,now()),disconnected_at=NULL,provider_sid=$2 WHERE id=$1 AND (connected_at IS NULL OR disconnected_at IS NOT NULL OR provider_sid IS DISTINCT FROM $2)',[g.id,p.sid]);
    await pool.query('UPDATE media_attendance SET left_at=now() WHERE grant_id=$1 AND provider_sid<>$2 AND left_at IS NULL',[g.id,p.sid]);
    await pool.query('INSERT INTO media_attendance(grant_id,provider_sid) VALUES($1,$2) ON CONFLICT(grant_id,provider_sid) WHERE left_at IS NULL DO NOTHING',[g.id,p.sid]);
    // Do not let a stale reconciler snapshot undo a newly committed share permission.
    await transaction(async db=>{
     if(!(await db.query('SELECT id FROM media_calls WHERE id=$1 AND ended_at IS NULL FOR NO KEY UPDATE',[r.call_id])).rowCount)return;
     if(!(await db.query('SELECT 1 FROM media_rooms WHERE id=$1 AND provider_room=$2 AND closed_at IS NULL',[r.id,r.provider_room])).rowCount)return;
     const share=(await db.query('SELECT grant_id FROM media_shares WHERE room_id=$1 AND expires_at>now()',[r.id])).rows[0];
     const allowed=sources(share?.grant_id===g.id);const actual=p.permission?.canPublishSources??[];
     if(actual.length!==allowed.length||actual.some(source=>!allowed.includes(source)))await rooms.updateParticipant(found.name,g.id,{permission:{canPublish:true,canSubscribe:true,canPublishData:false,canUpdateMetadata:false,canPublishSources:allowed}});
    });
   }else{
    await pool.query('UPDATE media_grants SET disconnected_at=now() WHERE id=$1 AND connected_at IS NOT NULL AND disconnected_at IS NULL',[g.id]);
    await pool.query('UPDATE media_attendance SET left_at=now() WHERE grant_id=$1 AND left_at IS NULL',[g.id]);
   }
  }
 }
 await pool.query('UPDATE media_attendance a SET left_at=now() FROM media_grants g JOIN media_calls x ON x.id=g.call_id WHERE a.grant_id=g.id AND a.left_at IS NULL AND (g.revoked_at IS NOT NULL OR x.ended_at IS NOT NULL)');
 // A host survives transient transport loss until the grant lease ends. Intentional leave revokes immediately.
 const orphaned=(await pool.query('SELECT x.id FROM media_calls x WHERE x.ended_at IS NULL AND EXISTS(SELECT 1 FROM media_grants g WHERE g.call_id=x.id AND g.user_id=x.host_user_id) AND NOT EXISTS(SELECT 1 FROM media_grants g WHERE g.call_id=x.id AND g.user_id=x.host_user_id AND g.revoked_at IS NULL AND g.expires_at>now())')).rows;
 for(const row of orphaned)await transaction(async db=>{const x=(await db.query('SELECT * FROM media_calls WHERE id=$1 FOR UPDATE',[row.id])).rows[0];if(!x||x.ended_at)return;if((await db.query('SELECT 1 FROM media_grants WHERE call_id=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>now()',[x.id,x.host_user_id])).rowCount)return;
  if((await db.query('SELECT 1 FROM calendar_media cm WHERE cm.call_id=$1 AND NOT EXISTS(SELECT 1 FROM media_attendance a JOIN media_grants g ON g.id=a.grant_id WHERE g.call_id=$1) AND NOT EXISTS(SELECT 1 FROM media_grants g WHERE g.call_id=$1 AND g.revoked_at IS NULL AND g.expires_at>now())',[x.id])).rowCount)return;
  const successor=(await db.query(`SELECT g.user_id FROM media_grants g JOIN channels c ON c.id=$1 WHERE g.call_id=$2 AND g.revoked_at IS NULL AND g.expires_at>now() AND ${accessSQL.replaceAll('$1','g.user_id')} ORDER BY g.joined_at,g.id LIMIT 1`,[x.channel_id,x.id])).rows[0];
  if(successor){await db.query('UPDATE media_calls SET host_user_id=$2 WHERE id=$1',[x.id,successor.user_id]);await audit(db,x.host_user_id,x.org_id,'media.host.succeeded',x.id);}
  else await db.query("UPDATE media_calls SET ended_at=now(),end_reason='empty' WHERE id=$1",[x.id]);
 });
}

async function historyAccess(req:FastifyRequest,db:DB){const call=await callAccess(db,req.user.id,idParam(req),idParam(req,'call'));if((await db.query('SELECT 1 FROM media_bans WHERE call_id=$1 AND user_id=$2',[call.id,req.user.id])).rowCount)throw new HttpError(403,'You were removed from this meeting');return call;}

export async function registerMeetingProtocol(app:FastifyInstance,readAuth:ReturnType<typeof sessionReader>=sessionReader()){
 const closers=new Set<()=>void>();app.addHook('preClose',async()=>{for(const close of closers)close();});
 app.addContentTypeParser('application/webhook+json',{parseAs:'string'},(_req,body,done)=>done(null,body));
 app.post('/v1/media/webhook',{bodyLimit:262144},async req=>{
  const c=mediaConfiguration();if(!c)throw new HttpError(503,'Media unavailable');let e;
  try{e=await new WebhookReceiver(c.key,c.secret).receive(typeof req.body==='string'?req.body:'',req.headers.authorization);}catch{throw new HttpError(401,'Invalid media callback');}
  if(!e.id||e.id.length>128)throw new HttpError(400,'Missing callback identifier');
  await transaction(async db=>{if(!(await db.query('INSERT INTO media_provider_events(id,kind) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING id',[e.id,e.event])).rowCount)return;
   const room=e.room?.name;if(!room?.startsWith('cc-'))return;const row=(await db.query('SELECT x.id,x.org_id FROM media_rooms r JOIN media_calls x ON x.id=r.call_id WHERE r.provider_room::text=$1 AND x.ended_at IS NULL',[room.slice(3)])).rows[0];if(row)await db.query('INSERT INTO media_changes(org_id,call_id,kind) VALUES($1,$2,$3)',[row.org_id,row.id,'provider.changed']);
  });return {ok:true};
 });
 app.get('/v1/organizations/:id/media/events',async(req,reply)=>{
  const org=idParam(req);await member(pool,req.user.id,org);const allowedOrigins=(process.env.WEB_ORIGIN??'http://localhost:3100').split(',').map(s=>s.trim());if(req.headers.origin&&!allowedOrigins.includes(req.headers.origin))throw new HttpError(403,'Origin not allowed');const id=randomUUID(),token=cookieHash(req);const requested=req.headers['last-event-id']??(req.query as {after?:string}).after;let after=requested===undefined?(await pool.query('SELECT coalesce(max(id),0)::text id FROM media_changes WHERE org_id=$1',[org])).rows[0].id:cursor.parse(requested);
  await transaction(async db=>{await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,127))',[req.user.id]);await db.query('DELETE FROM media_event_streams WHERE expires_at<=now()');if(Number((await db.query('SELECT count(*) FROM media_event_streams WHERE user_id=$1',[req.user.id])).rows[0].count)>=10)throw new HttpError(429,'Too many meeting event windows');await db.query("INSERT INTO media_event_streams VALUES($1,$2,$3,now()+interval '10 seconds')",[id,req.user.id,token]);});
  reply.raw.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','Access-Control-Allow-Origin':String(req.headers.origin??process.env.WEB_ORIGIN?.split(',')[0]??'http://localhost:3101'),'Access-Control-Allow-Credentials':'true','X-Accel-Buffering':'no'});reply.hijack();let stopped=false,busy=false;
  const stop=()=>{if(stopped)return;stopped=true;closers.delete(stop);clearInterval(timer);reply.raw.end();void pool.query('DELETE FROM media_event_streams WHERE id=$1',[id]).catch(()=>{});};
  const tick=async()=>{if(stopped||busy)return;busy=true;try{if(!(await readAuth(token)).rowCount)throw new HttpError(401,'Session ended');await member(pool,req.user.id,org);await pool.query("UPDATE media_event_streams SET expires_at=now()+interval '10 seconds' WHERE id=$1",[id]);const result=await pool.query(`SELECT e.id::text,e.call_id,e.kind FROM media_changes e JOIN media_calls x ON x.id=e.call_id JOIN channels c ON c.id=x.channel_id WHERE e.org_id=$2 AND e.id>$3 AND ${accessSQL} AND NOT EXISTS(SELECT 1 FROM media_bans b WHERE b.call_id=x.id AND b.user_id=$1) ORDER BY e.id LIMIT 100`,[req.user.id,org,after]);for(const e of result.rows){if(reply.raw.writableLength>65536){stop();return;}reply.raw.write(`id: ${e.id}\nevent: media.changed\ndata: ${JSON.stringify(e)}\n\n`);after=e.id;}if(!result.rowCount)reply.raw.write(': heartbeat\n\n');}catch{stop();}finally{busy=false;}};
  const timer=setInterval(()=>void tick(),1000);req.raw.on('close',stop);closers.add(stop);void tick();
 });
 app.post('/v1/organizations/:id/direct-conversation',async req=>{
  const b=z.object({userId:uuid}).strict().parse(req.body),org=idParam(req);return transaction(async db=>{const actor=await member(db,req.user.id,org);if(actor.role==='guest')throw new HttpError(403,'Guests cannot create conversations');if(b.userId===req.user.id)throw new HttpError(400,'Choose another participant');await member(db,b.userId,org);await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,128))',[[org,...[req.user.id,b.userId].sort()].join(':')]);const old=(await db.query("SELECT c.id FROM channels c WHERE c.org_id=$1 AND c.kind='direct' AND NOT c.archived AND (SELECT count(*) FROM channel_members m WHERE m.channel_id=c.id)=2 AND EXISTS(SELECT 1 FROM channel_members WHERE channel_id=c.id AND user_id=$2) AND EXISTS(SELECT 1 FROM channel_members WHERE channel_id=c.id AND user_id=$3) ORDER BY c.id LIMIT 1",[org,req.user.id,b.userId])).rows[0];if(old)return old;const id=randomUUID(),person=(await db.query('SELECT name FROM users WHERE id=$1 AND NOT disabled',[b.userId])).rows[0];if(!person)throw new HttpError(404,'Person unavailable');await db.query("INSERT INTO channels(id,org_id,name,kind) VALUES($1,$2,$3,'direct')",[id,org,`${req.user.name}, ${person.name}`]);for(const u of [req.user.id,b.userId])await db.query('INSERT INTO channel_members VALUES($1,$2,$3)',[org,id,u]);return {id};});
 });
 app.post('/v1/organizations/:id/instant-meetings',async req=>{
  if(!mediaConfiguration())throw new HttpError(503,'Configure LiveKit');const b=z.object({clientId:uuid,title:z.string().trim().min(1).max(160),mode:z.enum(['audio','video']),userIds:z.array(uuid).max(99)}).strict().parse(req.body),org=idParam(req);
  return transaction(async db=>{const actor=await member(db,req.user.id,org);if(actor.role==='guest')throw new HttpError(403,'Guests cannot create meetings');await db.query('SELECT pg_advisory_xact_lock(712399)');const old=(await db.query('SELECT id,channel_id FROM media_calls WHERE org_id=$1 AND caller_user_id=$2 AND client_id=$3 AND instant',[org,req.user.id,b.clientId])).rows[0];if(old)return {id:old.id,channelId:old.channel_id};if(Number((await db.query('SELECT count(*) FROM media_calls WHERE ended_at IS NULL')).rows[0].count)>=meetingLimits().calls)throw new HttpError(409,'Deployment call limit reached');const users=[...new Set([req.user.id,...b.userIds])];if(users.length>meetingLimits().invitations)throw new HttpError(409,'Meeting invitation limit reached');await validateAttendees(db,org,users);
   const channel=randomUUID(),id=randomUUID();await db.query("INSERT INTO channels(id,org_id,name,kind) VALUES($1,$2,$3,'group')",[channel,org,b.title]);for(const u of users)await db.query('INSERT INTO channel_members VALUES($1,$2,$3)',[org,channel,u]);await db.query("INSERT INTO media_calls(id,org_id,channel_id,host_user_id,caller_user_id,client_id,mode,instant,ring_until) VALUES($1,$2,$3,$4,$4,$5,$6,true,now()+interval '45 seconds')",[id,org,channel,req.user.id,b.clientId,b.mode]);await db.query("INSERT INTO media_rooms(id,call_id,name,client_id,is_main) VALUES($1,$1,'Main room',$1,true)",[id]);for(const u of users)await db.query("INSERT INTO media_invitations(call_id,user_id,response) VALUES($1,$2,$3)",[id,u,u===req.user.id?'accepted':(await db.query('SELECT 1 FROM media_grants g JOIN media_calls x ON x.id=g.call_id WHERE g.user_id=$1 AND g.revoked_at IS NULL AND g.expires_at>now() AND x.ended_at IS NULL',[u])).rowCount?'busy':'pending']);await audit(db,req.user.id,org,'media.instant.created',id);return {id,channelId:channel};});
 });
 app.get('/v1/organizations/:id/calls/:call/history',async req=>{
  const call=await historyAccess(req,pool);const attendance=(await pool.query('SELECT g.id,g.user_id,u.name,a.joined_at,a.left_at,EXTRACT(epoch FROM(coalesce(a.left_at,now())-a.joined_at))::double precision seconds FROM media_grants g JOIN users u ON u.id=g.user_id JOIN media_attendance a ON a.grant_id=g.id WHERE g.call_id=$1 ORDER BY a.joined_at,a.id LIMIT 1000',[call.id])).rows;return {id:call.id,createdAt:call.created_at,endedAt:call.ended_at,outcome:call.end_reason,seconds:Math.max(0,((call.ended_at?.getTime()??Date.now())-call.created_at.getTime())/1000),attendance};
 });
 app.get('/v1/organizations/:id/calls/:call/chat',async req=>{
  const call=await historyAccess(req,pool);if(!call.ended_at)throw new HttpError(409,'Use your connected room chat while meeting is active');const q=z.object({before:cursor.optional()}).strict().parse(req.query);const messages=(await pool.query('SELECT m.id,m.seq::text,m.user_id,u.name,m.body,m.created_at FROM media_messages m JOIN users u ON u.id=m.user_id WHERE m.call_id=$1 AND m.room_id=$1 AND ($2::bigint IS NULL OR m.seq<$2) ORDER BY m.seq DESC LIMIT 51',[call.id,q.before??null])).rows;return {roomId:call.id,messages:messages.slice(0,50).reverse(),hasMore:messages.length>50,nextCursor:messages.length>50?messages[49].seq:null};
 });
 app.post('/v1/organizations/:id/calls/:call/connections/:grant/share',async req=>{
  const b=z.object({sharing:z.boolean(),roomVersion:uuid}).strict().parse(req.body);
  const result=await transaction(async db=>{
   const {grant}=await collaborationGrant(req,db);
   // A delayed browser capture-ended callback must never release a newer generation's lease.
   if(b.roomVersion!==grant.provider_room)return {changed:true};
   const owner=(await db.query('SELECT grant_id,expires_at FROM media_shares WHERE room_id=$1',[grant.room_id])).rows[0];
   if(owner&&owner.expires_at<=new Date()){
    await db.query('DELETE FROM media_shares WHERE room_id=$1',[grant.room_id]);return {changed:true};
   }
   if(!b.sharing){await db.query('DELETE FROM media_shares WHERE room_id=$1 AND grant_id=$2',[grant.room_id,grant.id]);return {changed:false};}
   if(owner&&owner.grant_id!==grant.id)throw new HttpError(409,'Another participant is sharing in this room');
   // No new permission can be issued until every retired room has acknowledged deletion.
   await retireMediaCredentials();
   await db.query("INSERT INTO media_shares VALUES($1,$2,now()+interval '25 seconds') ON CONFLICT(room_id) DO UPDATE SET expires_at=excluded.expires_at",[grant.room_id,grant.id]);
   try{await mediaClients().rooms.updateParticipant(mediaRoomName(grant.provider_room),grant.id,{permission:{canPublish:true,canSubscribe:true,canPublishData:false,canUpdateMetadata:false,canPublishSources:sources(true)}});}
   catch{ // Even a timed-out RPC might have succeeded. Commit retirement before returning failure.
    await db.query('DELETE FROM media_shares WHERE room_id=$1 AND grant_id=$2',[grant.room_id,grant.id]);return {unavailable:true};
   }
   return {changed:false};
  });
  try{await retireMediaCredentials();}catch{throw new HttpError(503,'Sharing authorization is recovering; reconnect before trying again');}
  if(result.unavailable)throw new HttpError(503,'Sharing permission unavailable; reconnect before trying again');
  if(result.changed&&b.sharing)throw new HttpError(409,'Meeting room changed; reconnect and choose Share screen again');
  return {ok:true};
 });
 app.post('/v1/organizations/:id/calls/:call/connections/:grant/read-chat',async req=>{const b=z.object({seq:cursor}).strict().parse(req.body);await transaction(async db=>{const {grant}=await collaborationGrant(req,db);const maximum=(await db.query('SELECT coalesce(max(seq),0)::text seq FROM media_messages WHERE room_id=$1',[grant.room_id])).rows[0].seq;if(BigInt(b.seq)>BigInt(maximum))throw new HttpError(400,'Invalid chat position');await db.query('INSERT INTO media_chat_reads VALUES($1,$2,$3,$4) ON CONFLICT(room_id,user_id) DO UPDATE SET last_seq=greatest(media_chat_reads.last_seq,excluded.last_seq)',[grant.call_id,grant.room_id,req.user.id,b.seq]);});return {ok:true};});
 app.post('/v1/organizations/:id/calls/:call/connections/:grant/dismiss-unmute',async req=>{empty.parse(req.body);await transaction(async db=>{const {grant}=await collaborationGrant(req,db);await db.query('UPDATE media_grants SET unmute_requested_at=NULL WHERE id=$1',[grant.id]);});return {ok:true};});
}
