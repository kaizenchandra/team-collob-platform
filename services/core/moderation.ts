import {requireUnheld} from './preservation.ts';
import type {FastifyInstance} from 'fastify';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {pool,transaction} from './db.ts';
import {member,channel,accessSQL,HttpError,audit,event} from './security.ts';
import {idParam} from './server.ts';
const receipt=(r:Record<string,unknown>)=>({id:r.id,status:r.status,reason:r.reason,details:r.details,created_at:r.created_at});
export async function registerModeration(app:FastifyInstance){
  app.get('/v1/channels/:id/messages/:message/report',async req=>{
    const id=idParam(req),mid=idParam(req,'message');await channel(pool,req.user.id,id);
    const r=(await pool.query('SELECT * FROM message_reports WHERE channel_id=$1 AND message_id=$2 AND reporter_id=$3',[id,mid,req.user.id])).rows[0];return {report:r?receipt(r):null};
  });
  app.post('/v1/channels/:id/messages/:message/report',async req=>{
    const id=idParam(req),mid=idParam(req,'message'),b=z.object({reason:z.enum(['spam','harassment','unsafe','other']),details:z.string().trim().max(1000).default('')}).strict().parse(req.body);
    return transaction(async db=>{
      const c=await channel(db,req.user.id,id,true);if(!['standard','private','shared'].includes(c.kind))throw new HttpError(400,'Message reports are currently available only in team channels');
      const old=(await db.query('SELECT * FROM message_reports WHERE message_id=$1 AND reporter_id=$2 AND channel_id=$3',[mid,req.user.id,id])).rows[0];
      if(old){if(old.reason!==b.reason||old.details!==b.details)throw new HttpError(409,'You already reported this message with different details');return {report:receipt(old)};}
      if(!(await db.query('SELECT id FROM messages WHERE id=$1 AND channel_id=$2 AND NOT deleted',[mid,id])).rowCount)throw new HttpError(404,'Reportable message unavailable');
      const count=Number((await db.query("SELECT count(*) FROM message_reports WHERE channel_id=$1 AND reporter_id=$2 AND created_at>now()-interval '1 hour'",[id,req.user.id])).rows[0].count);if(count>=10)throw new HttpError(429,'Report limit reached for this channel. Try again later.');
      const r=(await db.query('INSERT INTO message_reports(id,org_id,channel_id,message_id,reporter_id,reason,details) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[randomUUID(),c.org_id,id,mid,req.user.id,b.reason,b.details])).rows[0];await audit(db,req.user.id,c.org_id,'message.reported',r.id);return {report:receipt(r)};
    });
  });
  app.get('/v1/organizations/:id/message-reports',async req=>{
    const org=idParam(req);await member(pool,req.user.id,org,true);
    const q=z.object({status:z.enum(['open','dismissed','removed']).default('open'),limit:z.coerce.number().int().min(1).max(50).default(20),beforeCreated:z.iso.datetime().optional(),beforeId:z.uuid().optional()}).strict().parse(req.query);
    if(!!q.beforeCreated!==!!q.beforeId)throw new HttpError(400,'Provide both report cursor fields');
    const rows=(await pool.query(`SELECT r.*,c.name channel_name,m.body message_body,m.deleted message_deleted,u.name reporter_name,author.name author_name,
      to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') cursor_created
      FROM message_reports r JOIN channels c ON c.id=r.channel_id JOIN messages m ON m.id=r.message_id JOIN users u ON u.id=r.reporter_id JOIN users author ON author.id=m.user_id
      WHERE r.org_id=$2 AND r.status=$3 AND ${accessSQL} AND ($4::timestamptz IS NULL OR (r.created_at,r.id)<($4,$5::uuid)) ORDER BY r.created_at DESC,r.id DESC LIMIT $6`,[req.user.id,org,q.status,q.beforeCreated??null,q.beforeId??null,q.limit+1])).rows;
    const page=rows.slice(0,q.limit),last=page.at(-1);return {items:page.map(row=>{const {cursor_created,...item}=row;void cursor_created;return item;}),nextCursor:rows.length>q.limit?{createdAt:last.cursor_created,id:last.id}:null};
  });
  app.post('/v1/organizations/:id/message-reports/:report/resolve',async req=>{
    const org=idParam(req),id=idParam(req,'report'),b=z.object({revision:z.number().int().positive(),action:z.enum(['dismiss','remove']),note:z.string().trim().max(1000).default('')}).strict().parse(req.body);
    return transaction(async db=>{
      await member(db,req.user.id,org,true);const location=(await db.query('SELECT channel_id FROM message_reports WHERE id=$1 AND org_id=$2',[id,org])).rows[0];if(!location)throw new HttpError(404,'Report unavailable');
      const c=await channel(db,req.user.id,location.channel_id,true),r=(await db.query('SELECT * FROM message_reports WHERE id=$1 FOR UPDATE',[id])).rows[0],status=b.action==='dismiss'?'dismissed':'removed';
      if(r.status!=='open'){
        if(r.status===status&&r.resolved_by===req.user.id&&r.resolution_note===b.note&&r.revision===b.revision+1)return {ok:true,status,revision:r.revision};
        throw new HttpError(409,'Report already resolved. Refresh the review queue.');
      }
      if(r.revision!==b.revision)throw new HttpError(409,'Report changed. Refresh the review queue.');
      if(b.action==='remove'){
        await requireUnheld(db,c.id);
        const removed=await db.query("UPDATE messages SET body='',deleted=true WHERE id=$1 AND channel_id=$2 AND NOT deleted RETURNING id",[r.message_id,c.id]);
        await db.query('DELETE FROM message_mentions WHERE message_id=$1',[r.message_id]);
        if(removed.rowCount){await event(db,org,c.id,'message.deleted',{id:r.message_id});await audit(db,req.user.id,org,'message.deleted',r.message_id);}
      }
      await db.query('UPDATE message_reports SET status=$2,revision=revision+1,resolved_by=$3,resolved_at=now(),resolution_note=$4 WHERE id=$1',[id,status,req.user.id,b.note]);await audit(db,req.user.id,org,'message.report_resolved',id,{action:b.action});return {ok:true,status,revision:r.revision+1};
    });
  });
}
