import type {FastifyInstance} from 'fastify';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {transaction,type DB} from './db.ts';
import {member,audit,event,HttpError} from './security.ts';
import {idParam} from './server.ts';
async function roster(db:DB,team:string){
  const rows=(await db.query(`SELECT u.id,u.name,tm.role,(m.active AND NOT u.disabled) active FROM team_members tm
    JOIN memberships m ON m.org_id=tm.org_id AND m.user_id=tm.user_id JOIN users u ON u.id=tm.user_id
    WHERE tm.team_id=$1 ORDER BY u.id LIMIT 1001`,[team])).rows;
  if(rows.length>1000)throw new HttpError(413,'Administrative roster is limited to 1000 team members');
  return {rows,token:createHash('sha256').update(JSON.stringify(rows.map(r=>[r.id,r.role]))).digest('hex')};
}
async function authorize(db:DB,org:string,team:string,user:string){
  await member(db,user,org,true);
  if(!(await db.query('SELECT 1 FROM team_members WHERE team_id=$1 AND user_id=$2',[team,user])).rowCount)throw new HttpError(404,'Team membership required');
}
export async function registerTeamMembers(app:FastifyInstance){
  app.get('/v1/organizations/:id/teams/:team/members',async req=>transaction(async db=>{
    const org=idParam(req),team=idParam(req,'team');const t=(await db.query('SELECT id,name,archived FROM teams WHERE id=$1 AND org_id=$2 FOR UPDATE',[team,org])).rows[0];if(!t)throw new HttpError(404,'Team unavailable');
    await authorize(db,org,team,req.user.id);const r=await roster(db,team);
    return {teamId:t.id,name:t.name,archived:t.archived,membershipToken:r.token,members:r.rows};
  }));
  for(const method of ['PUT','DELETE'] as const){
    app.route({method,url:'/v1/organizations/:id/teams/:team/members/:user',handler:async req=>{
      const org=idParam(req),team=idParam(req,'team'),user=idParam(req,'user').toLowerCase(),expectedMembership=z.string().regex(/^[a-f0-9]{64}$/);
      const b=(method==='PUT'?z.object({expectedMembership,history:z.literal('all-retained-standard')}).strict():z.object({expectedMembership}).strict()).parse(req.body);
      return transaction(async db=>{
        const t=(await db.query('SELECT archived FROM teams WHERE id=$1 AND org_id=$2 FOR UPDATE',[team,org])).rows[0];if(!t)throw new HttpError(404,'Team unavailable');
        await db.query('SELECT id FROM channels WHERE team_id=$1 ORDER BY id FOR UPDATE',[team]);
        await db.query('SELECT user_id FROM memberships WHERE org_id=$1 AND user_id=ANY($2::uuid[]) ORDER BY user_id FOR SHARE',[org,[req.user.id,user]]);
        await authorize(db,org,team,req.user.id);if(t.archived)throw new HttpError(409,'Restore the team before changing membership');
        const r=await roster(db,team);if(r.token!==b.expectedMembership)throw new HttpError(409,'Team membership changed. Refresh team members before retrying.');
        const present=r.rows.find(p=>p.id===user);
        if(method==='PUT'){
          if(!(await db.query('SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.org_id=$1 AND m.user_id=$2 AND m.active AND NOT u.disabled',[org,user])).rowCount)throw new HttpError(404,'Member unavailable in this workspace');
          if(present)return {changed:false};if(r.rows.length>=1000)throw new HttpError(409,'Administrative team admission limit reached (1000)');
        }else{
          if(user===req.user.id)throw new HttpError(400,'Use Leave team to remove your own membership');
          if(present?.role==='owner')throw new HttpError(409,'Transfer ownership before removing a team owner');
          if(!present)return {changed:false};
        }
        const affected=(await db.query(`SELECT c.id,c.kind FROM channels c WHERE c.team_id=$1 AND (c.kind='standard' OR ($3 AND c.kind='private' AND EXISTS(SELECT 1 FROM channel_members cm WHERE cm.channel_id=c.id AND cm.user_id=$2))) ORDER BY c.id`,[team,user,method==='DELETE'])).rows;
        if(method==='PUT')await db.query("INSERT INTO team_members(org_id,team_id,user_id,role) VALUES($1,$2,$3,'member')",[org,team,user]);
        else{
          await db.query('DELETE FROM team_members WHERE team_id=$1 AND user_id=$2',[team,user]);
          await db.query("DELETE FROM channel_members WHERE user_id=$2 AND channel_id IN(SELECT id FROM channels WHERE team_id=$1 AND kind='private')",[team,user]);
          for(const table of ['drafts','channel_preferences'])await db.query(`DELETE FROM ${table} WHERE user_id=$1 AND channel_id=ANY($2::uuid[])`,[user,affected.map(c=>c.id)]);
        }
        for(const c of affected){await db.query('UPDATE channels SET revision=revision+1 WHERE id=$1',[c.id]);await event(db,org,c.id,'channel.updated');}
        await audit(db,req.user.id,org,method==='PUT'?'team.member_added':'team.member_removed',team,{userId:user,channelsAffected:affected.length,...(method==='PUT'?{history:'all-retained-standard'}:{privateGrantsRemoved:affected.filter(c=>c.kind==='private').length})});return {changed:true,channelsAffected:affected.length};
      });
    }});
  }
}
