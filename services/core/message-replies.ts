import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {pool} from './db.ts';
import {accessSQL,HttpError,member} from './security.ts';
import {idParam} from './server.ts';
const query=z.object({beforeCreated:z.iso.datetime().refine(value=>!value.startsWith('0000-'),'Invalid cursor year').optional(),beforeId:z.uuid().optional()}).strict();
export async function registerMessageReplies(app:FastifyInstance){
  app.get('/v1/organizations/:id/channels/:channel/messages/:message/replies',async req=>{
    const org=idParam(req),channel=idParam(req,'channel'),parent=idParam(req,'message'),q=query.parse(req.query);
    if(!!q.beforeCreated!==!!q.beforeId)throw new HttpError(400,'Provide both reply cursor fields');
    await member(pool,req.user.id,org);
    // Parent authorization and child projection share one database snapshot.
    const row=(await pool.query(`SELECT parent.id parent_id,c.id channel_id,c.name channel_name,coalesce(children.items,'[]'::json) replies
      FROM messages parent JOIN channels c ON c.id=parent.channel_id
      LEFT JOIN LATERAL (
        SELECT json_agg(item ORDER BY item.cursor_created DESC,item.id DESC) items FROM (
          SELECT m.id,u.name author,m.created_at,left(m.body,500) excerpt,
            to_char(m.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') cursor_created
          FROM messages m JOIN users u ON u.id=m.user_id
          WHERE m.org_id=parent.org_id AND m.channel_id=parent.channel_id AND m.parent_id=parent.id AND NOT m.deleted
            AND ($5::timestamptz IS NULL OR (m.created_at,m.id)<($5,$6::uuid))
          ORDER BY m.created_at DESC,m.id DESC LIMIT 51
        ) item
      ) children ON true
      WHERE c.org_id=$2 AND c.id=$3 AND parent.id=$4 AND parent.org_id=$2 AND NOT parent.deleted AND ${accessSQL}`,
      [req.user.id,org,channel,parent,q.beforeCreated??null,q.beforeId??null])).rows[0];
    if(!row)throw new HttpError(404,'Message unavailable');
    const rows=row.replies as {id:string;author:string;created_at:string;excerpt:string;cursor_created:string}[],page=rows.slice(0,50),last=page.at(-1),hasMore=rows.length>50;
    return {channel:{id:row.channel_id,name:row.channel_name},parentId:row.parent_id,replies:page.map(({cursor_created,...reply})=>{void cursor_created;return reply;}),hasMore,nextCursor:hasMore&&last?{createdAt:last.cursor_created,id:last.id}:null};
  });
}
