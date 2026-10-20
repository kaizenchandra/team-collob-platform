import {isQuietHours} from "./notification-time.ts";
export {isQuietHours} from "./notification-time.ts";
import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {pool,transaction} from './db.ts';
import {member,accessSQL} from './security.ts';
import {idParam} from './server.ts';
const time=z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const settings=z.object({browser_enabled:z.boolean(),quiet_enabled:z.boolean(),quiet_start:time,quiet_end:time,digest_enabled:z.boolean().optional(),browser_replies_enabled:z.boolean().optional()});
export async function registerNotifications(app:FastifyInstance){
  app.get('/v1/notification-settings',async req=>{
    const row=(await pool.query('SELECT browser_enabled,quiet_enabled,quiet_start,quiet_end,digest_enabled,browser_replies_enabled FROM notification_settings WHERE user_id=$1',[req.user.id])).rows[0];
    return {...(row??{browser_enabled:false,quiet_enabled:false,quiet_start:'22:00',quiet_end:'08:00',digest_enabled:false,browser_replies_enabled:false}),email_provider:process.env.SMTP_HOST?(process.env.SMTP_LOCAL_CAPTURE==='true'?'local-capture':'configured'):'unconfigured'};
  });
  app.put('/v1/notification-settings',async req=>{
    const b=settings.parse(req.body);
    await pool.query(`INSERT INTO notification_settings(user_id,browser_enabled,quiet_enabled,quiet_start,quiet_end,digest_enabled,browser_replies_enabled) VALUES($1,$2,$3,$4,$5,coalesce($6,false),coalesce($7,false))
      ON CONFLICT(user_id) DO UPDATE SET browser_replies_enabled=coalesce($7,notification_settings.browser_replies_enabled),
      replies_enabled_at=CASE WHEN NOT notification_settings.browser_replies_enabled AND $7 THEN now() ELSE notification_settings.replies_enabled_at END,
      digest_enabled=coalesce($6,notification_settings.digest_enabled),
      digest_since=CASE WHEN NOT notification_settings.digest_enabled AND $6 THEN now() ELSE notification_settings.digest_since END,
      digest_checked_at=CASE WHEN NOT notification_settings.digest_enabled AND $6 THEN '-infinity'::timestamptz ELSE notification_settings.digest_checked_at END,
      browser_enabled=$2,quiet_enabled=$3,quiet_start=$4,quiet_end=$5,
      enabled_at=CASE WHEN NOT notification_settings.browser_enabled AND $2 THEN now() ELSE notification_settings.enabled_at END`,[req.user.id,b.browser_enabled,b.quiet_enabled,b.quiet_start,b.quiet_end,b.digest_enabled??null,b.browser_replies_enabled??null]);
    return {ok:true};
  });
  app.patch('/v1/notification-settings',async req=>{
    z.object({}).strict().parse(req.query);
    const b=settings.partial().strict().refine(value=>Object.keys(value).length>0,'Provide at least one preference').parse(req.body);
    await pool.query(`INSERT INTO notification_settings(user_id,browser_enabled,quiet_enabled,quiet_start,quiet_end,digest_enabled,browser_replies_enabled)
      VALUES($1,coalesce($2::boolean,false),coalesce($3::boolean,false),coalesce($4::text,'22:00'),coalesce($5::text,'08:00'),coalesce($6::boolean,false),coalesce($7::boolean,false))
      ON CONFLICT(user_id) DO UPDATE SET
      browser_enabled=coalesce($2,notification_settings.browser_enabled),quiet_enabled=coalesce($3,notification_settings.quiet_enabled),
      quiet_start=coalesce($4,notification_settings.quiet_start),quiet_end=coalesce($5,notification_settings.quiet_end),
      digest_enabled=coalesce($6,notification_settings.digest_enabled),browser_replies_enabled=coalesce($7,notification_settings.browser_replies_enabled),
      enabled_at=CASE WHEN NOT notification_settings.browser_enabled AND $2 THEN now() ELSE notification_settings.enabled_at END,
      replies_enabled_at=CASE WHEN NOT notification_settings.browser_replies_enabled AND $7 THEN now() ELSE notification_settings.replies_enabled_at END,
      digest_since=CASE WHEN NOT notification_settings.digest_enabled AND $6 THEN now() ELSE notification_settings.digest_since END,
      digest_checked_at=CASE WHEN NOT notification_settings.digest_enabled AND $6 THEN '-infinity'::timestamptz ELSE notification_settings.digest_checked_at END`,
      [req.user.id,b.browser_enabled??null,b.quiet_enabled??null,b.quiet_start??null,b.quiet_end??null,b.digest_enabled??null,b.browser_replies_enabled??null]);
    return {ok:true};
  });
  app.get('/v1/digest-jobs',async req=>({jobs:(await pool.query('SELECT id,state,attempts,last_error,created_at,accepted_at FROM digest_jobs WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20',[req.user.id])).rows}));
  app.post('/v1/organizations/:id/notification-claims',async req=>{
    const org=idParam(req);
    return transaction(async db=>{
      await member(db,req.user.id,org);
      const pref=(await db.query('SELECT s.*,u.timezone FROM notification_settings s JOIN users u ON u.id=s.user_id WHERE s.user_id=$1 AND NOT u.disabled FOR UPDATE OF s',[req.user.id])).rows[0];
      if(!pref || (!pref.browser_enabled&&!pref.browser_replies_enabled))return {items:[],suppressed:'disabled'};
      if(pref.quiet_enabled&&isQuietHours(pref.timezone,pref.quiet_start,pref.quiet_end))return {items:[],suppressed:'quiet-hours'};
      const items=(await db.query(`SELECT m.id,m.channel_id,c.name channel_name,o.name organization_name,
        CASE WHEN mm.user_id IS NOT NULL AND $3 AND m.created_at >= $4 THEN 'mention' ELSE 'reply' END kind
        FROM messages m LEFT JOIN message_mentions mm ON mm.message_id=m.id AND mm.user_id=$1
        LEFT JOIN messages parent ON parent.id=m.parent_id AND parent.channel_id=m.channel_id AND parent.org_id=m.org_id AND parent.user_id=$1 AND NOT parent.deleted
        JOIN channels c ON c.id=m.channel_id JOIN organizations o ON o.id=c.org_id
        LEFT JOIN read_positions r ON r.channel_id=c.id AND r.user_id=$1
        LEFT JOIN channel_preferences p ON p.channel_id=c.id AND p.user_id=$1
        WHERE c.org_id=$2 AND ${accessSQL} AND NOT m.deleted AND m.user_id<>$1
        AND m.seq>coalesce(r.seq,0) AND NOT coalesce(p.muted,false) AND NOT coalesce(p.hidden,false)
        AND ((mm.user_id IS NOT NULL AND $3 AND m.created_at >= $4) OR (parent.id IS NOT NULL AND $5 AND m.created_at >= $6))
        AND m.created_at >= now()-interval '24 hours'
        AND NOT EXISTS(SELECT 1 FROM notification_claims n WHERE n.user_id=$1 AND n.message_id=m.id)
        ORDER BY m.created_at,m.id LIMIT 10`,[req.user.id,org,pref.browser_enabled,pref.enabled_at,pref.browser_replies_enabled,pref.replies_enabled_at])).rows;
      for(const item of items)await db.query('INSERT INTO notification_claims(user_id,message_id) VALUES($1,$2)',[req.user.id,item.id]);
      return {items,suppressed:null};
    });
  });
}
