import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {pool} from './db.ts';
import {accessSQL,HttpError,member} from './security.ts';
import {idParam} from './server.ts';
const query=z.object({afterId:z.uuid().optional()}).strict();
export async function registerMessageReaders(app:FastifyInstance){
  app.get('/v1/organizations/:id/channels/:channel/messages/:message/readers',async req=>{
    const org=idParam(req),channel=idParam(req,'channel'),message=idParam(req,'message'),q=query.parse(req.query);
    await member(pool,req.user.id,org);
    const row=(await pool.query(`SELECT c.id channel_id,c.name channel_name,m.id message_id,m.created_at,left(m.body,500) excerpt,coalesce(readers.items,'[]'::json) readers
      FROM messages m JOIN channels c ON c.id=m.channel_id
      LEFT JOIN LATERAL (
        SELECT json_agg(item ORDER BY item.id) items FROM (
          SELECT u.id,u.name FROM read_positions r JOIN users u ON u.id=r.user_id
          WHERE r.channel_id=c.id AND r.seq>=m.seq AND u.id<>$1 AND NOT u.disabled
            AND coalesce((u.preferences->>'readReceipts')::boolean,true)
            AND EXISTS(SELECT 1 FROM memberships om WHERE om.org_id=c.org_id AND om.user_id=u.id AND om.active)
            AND (c.kind='standard' AND EXISTS(SELECT 1 FROM team_members tm WHERE tm.team_id=c.team_id AND tm.user_id=u.id)
              OR c.kind<>'standard' AND EXISTS(SELECT 1 FROM channel_members cm WHERE cm.channel_id=c.id AND cm.user_id=u.id))
            AND ($5::uuid IS NULL OR u.id>$5)
          ORDER BY u.id LIMIT 51
        ) item
      ) readers ON true
      WHERE c.org_id=$2 AND c.id=$3 AND m.org_id=$2 AND m.id=$4 AND m.user_id=$1 AND NOT m.deleted AND ${accessSQL}`,
      [req.user.id,org,channel,message,q.afterId??null])).rows[0];
    if(!row)throw new HttpError(404,'Message readers unavailable');
    const rows=row.readers as {id:string;name:string}[],readers=rows.slice(0,50),hasMore=rows.length>50;
    return {channel:{id:row.channel_id,name:row.channel_name},message:{id:row.message_id,created_at:row.created_at,excerpt:row.excerpt},readers,hasMore,nextCursor:hasMore?readers.at(-1)!.id:null};
  });
}
