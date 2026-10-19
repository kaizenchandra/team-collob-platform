import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {pool,transaction} from './db.ts';
import {HttpError} from './security.ts';
import {idParam} from './server.ts';
export async function registerPresence(app:FastifyInstance) {
  app.get('/v1/organizations/:id/presence',async req=>{
    const org=idParam(req);z.object({}).strict().parse(req.query);
    const row=(await pool.query(`SELECT
      CASE WHEN p.last_seen IS NULL OR p.last_seen<now()-interval '60 seconds' THEN 'offline' WHEN p.override_until>now() THEN p.state ELSE 'available' END state,
      p.state override_state,p.override_until,p.override_until>now() override_active
      FROM memberships m JOIN users u ON u.id=m.user_id LEFT JOIN presence p ON p.org_id=m.org_id AND p.user_id=m.user_id
      WHERE m.org_id=$1 AND m.user_id=$2 AND m.active AND NOT u.disabled`,[org,req.user.id])).rows[0];
    if(!row)throw new HttpError(404,'Workspace unavailable');
    return {org_id:org,user_id:req.user.id,state:row.state,override:row.override_active?{state:row.override_state,until:row.override_until.toISOString()}:null};
  });
  app.delete('/v1/organizations/:id/presence',async req=>{
    const org=idParam(req);z.object({}).strict().parse(req.query);z.object({}).strict().parse(req.body);
    return transaction(async db=>{
      const membership=await db.query('SELECT m.user_id FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.org_id=$1 AND m.user_id=$2 AND m.active AND NOT u.disabled FOR SHARE OF m',[org,req.user.id]);
      if(!membership.rowCount)throw new HttpError(404,'Workspace unavailable');
      await db.query(`UPDATE presence p SET state='available',override_until=NULL FROM memberships m JOIN users u ON u.id=m.user_id
        WHERE p.org_id=$1 AND p.user_id=$2 AND m.org_id=p.org_id AND m.user_id=p.user_id AND m.active AND NOT u.disabled
        AND (p.override_until IS NOT NULL OR p.state<>'available')`,[org,req.user.id]);
      return {ok:true};
    });
  });
}
