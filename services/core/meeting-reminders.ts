import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {pool,transaction,type DB} from './db.ts';
import {member,HttpError} from './security.ts';
import {idParam} from './server.ts';
import {isQuietHours} from './notification-time.ts';
async function attendee(db:DB,user:string,org:string,id:string){
  await member(db,user,org);
  const meeting=(await db.query('SELECT * FROM meetings WHERE id=$1 AND org_id=$2 FOR SHARE',[id,org])).rows[0];
  if(!meeting)throw new HttpError(404,'Meeting unavailable');
  if(!(await db.query('SELECT user_id FROM meeting_attendees WHERE meeting_id=$1 AND user_id=$2 FOR SHARE',[id,user])).rowCount)throw new HttpError(404,'Meeting unavailable');
  if(meeting.cancelled)throw new HttpError(409,'Cancelled meetings cannot have reminders');
}
export async function registerMeetingReminders(app:FastifyInstance){
  app.put('/v1/organizations/:id/meetings/:meeting/reminder',async req=>{
    const org=idParam(req),id=idParam(req,'meeting'),b=z.object({minutes:z.union([z.literal(0),z.literal(5),z.literal(15),z.literal(30),z.literal(60)])}).strict().parse(req.body);
    return transaction(async db=>{await attendee(db,req.user.id,org,id);
      if(!b.minutes)await db.query('DELETE FROM meeting_reminders WHERE meeting_id=$1 AND user_id=$2',[id,req.user.id]);
      else await db.query('INSERT INTO meeting_reminders(meeting_id,user_id,minutes) VALUES($1,$2,$3) ON CONFLICT(meeting_id,user_id) DO UPDATE SET minutes=$3',[id,req.user.id,b.minutes]);
      return {minutes:b.minutes};
    });
  });
  app.get('/v1/organizations/:id/meeting-reminders',async req=>{
    const org=idParam(req);await member(pool,req.user.id,org);
    const pref=(await pool.query('SELECT u.timezone,u.disabled,s.quiet_enabled,s.quiet_start,s.quiet_end FROM users u LEFT JOIN notification_settings s ON s.user_id=u.id WHERE u.id=$1',[req.user.id])).rows[0];
    if(pref.disabled)return {items:[],suppressed:'disabled'};
    if(pref.quiet_enabled&&isQuietHours(pref.timezone,pref.quiet_start,pref.quiet_end))return {items:[],suppressed:'quiet-hours'};
    const items=(await pool.query(`SELECT m.id,m.title,m.timezone,to_char(m.starts_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') starts_at,r.minutes
      FROM meeting_reminders r JOIN meeting_attendees a ON a.meeting_id=r.meeting_id AND a.user_id=r.user_id JOIN meetings m ON m.id=r.meeting_id
      JOIN memberships mb ON mb.org_id=m.org_id AND mb.user_id=r.user_id AND mb.active
      WHERE r.user_id=$1 AND m.org_id=$2 AND NOT m.cancelled AND a.response<>'declined'
      AND m.starts_at>now() AND m.starts_at<=now()+r.minutes*interval '1 minute'
      AND r.dismissed_start IS DISTINCT FROM m.starts_at ORDER BY m.starts_at,m.id LIMIT 20`,[req.user.id,org])).rows;
    return {items,suppressed:null};
  });
  app.post('/v1/organizations/:id/meetings/:meeting/reminder/dismiss',async req=>{
    const org=idParam(req),id=idParam(req,'meeting'),b=z.object({startsAt:z.iso.datetime()}).strict().parse(req.body);
    return transaction(async db=>{await attendee(db,req.user.id,org,id);
      const row=await db.query('UPDATE meeting_reminders r SET dismissed_start=m.starts_at FROM meetings m WHERE r.meeting_id=m.id AND r.meeting_id=$1 AND r.user_id=$2 AND m.starts_at=$3::timestamptz RETURNING r.meeting_id',[id,req.user.id,b.startsAt]);
      if(!row.rowCount)throw new HttpError(409,'Reminder changed. Refresh before dismissing.');return {ok:true};
    });
  });
}
