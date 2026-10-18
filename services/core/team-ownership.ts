import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {createHash} from 'node:crypto';
import {transaction} from './db.ts';
import {member,audit,HttpError} from './security.ts';
import {idParam} from './server.ts';
const uuid=z.uuid().transform(v=>v.toLowerCase());
const recoveryToken=(owners:{id:string;active:boolean}[])=>createHash('sha256').update(JSON.stringify([...owners].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0).map(o=>[o.id,o.active]))).digest('hex');
export async function registerTeamOwnership(app:FastifyInstance){
  app.get('/v1/organizations/:id/teams/:team/ownership',async req=>transaction(async db=>{
    const org=idParam(req),team=idParam(req,'team');
    const t=(await db.query('SELECT id,name,archived FROM teams WHERE id=$1 AND org_id=$2 FOR UPDATE',[team,org])).rows[0];
    if(!t)throw new HttpError(404,'Team unavailable');const membership=await member(db,req.user.id,org);
    const actor=(await db.query('SELECT role FROM team_members WHERE team_id=$1 AND user_id=$2',[team,req.user.id])).rows[0];
    if(!actor)throw new HttpError(404,'Team membership required');
    const rows=(await db.query(`SELECT u.id,u.name,tm.role,(m.active AND NOT u.disabled) active,m.role workspace_role
      FROM team_members tm JOIN users u ON u.id=tm.user_id JOIN memberships m ON m.org_id=tm.org_id AND m.user_id=tm.user_id
      WHERE tm.team_id=$1 ORDER BY u.name,u.id LIMIT 1001`,[team])).rows;
    if(rows.length>1000)throw new HttpError(413,'Ownership view is limited to teams with at most 1000 members');
    const owners=rows.filter(r=>r.role==='owner').map(r=>({id:r.id,name:r.name,active:r.active}));
    return {can_recover:membership.role==='owner'&&!t.archived&&!owners.some(o=>o.active),recoveryToken:recoveryToken(owners),teamId:t.id,name:t.name,archived:t.archived,can_transfer:actor.role==='owner'&&!t.archived,
      owners,
      candidates:rows.filter(r=>r.role!=='owner'&&r.active&&r.workspace_role!=='guest').map(r=>({id:r.id,name:r.name}))};
  }));
  app.post('/v1/organizations/:id/teams/:team/recover-ownership',async req=>{
    const org=idParam(req),team=idParam(req,'team'),b=z.object({userId:uuid,expectedRecovery:z.string().regex(/^[a-f0-9]{64}$/),confirm:z.literal(true)}).strict().parse(req.body);
    return transaction(async db=>{
      const t=(await db.query('SELECT archived FROM teams WHERE id=$1 AND org_id=$2 FOR UPDATE',[team,org])).rows[0];if(!t)throw new HttpError(404,'Team unavailable');
      if((await member(db,req.user.id,org)).role!=='owner')throw new HttpError(403,'Current workspace ownership required for recovery');
      if(!(await db.query('SELECT 1 FROM team_members WHERE team_id=$1 AND user_id=$2',[team,req.user.id])).rowCount)throw new HttpError(404,'Team membership required');
      const previous=(await db.query("SELECT user_id FROM team_members WHERE team_id=$1 AND role='owner' ORDER BY user_id LIMIT 1001",[team])).rows.map(r=>r.user_id as string);
      if(previous.length>1000)throw new HttpError(413,'Ownership recovery is limited to 1000 owners');
      const affected=[...new Set([...previous,req.user.id,b.userId])].sort();
      await db.query('SELECT id FROM users WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE',[affected]);
      await db.query('SELECT user_id FROM memberships WHERE org_id=$1 AND user_id=ANY($2::uuid[]) ORDER BY user_id FOR SHARE',[org,affected]);
      if((await member(db,req.user.id,org)).role!=='owner')throw new HttpError(403,'Current workspace ownership required for recovery');
      if(!(await db.query('SELECT 1 FROM team_members WHERE team_id=$1 AND user_id=$2',[team,req.user.id])).rowCount)throw new HttpError(404,'Team membership required');
      if(t.archived)throw new HttpError(409,'Restore the team before recovering ownership');
      const owners=(await db.query(`SELECT tm.user_id id,(m.active AND NOT u.disabled) active FROM team_members tm
        JOIN memberships m ON m.org_id=tm.org_id AND m.user_id=tm.user_id JOIN users u ON u.id=tm.user_id
        WHERE tm.team_id=$1 AND tm.role='owner' ORDER BY tm.user_id`,[team])).rows;
      if(owners.some(o=>o.active))throw new HttpError(409,'Team has an active owner. Use ownership transfer.');
      if(recoveryToken(owners)!==b.expectedRecovery)throw new HttpError(409,'Team owner state changed. Refresh ownership before retrying.');
      const eligible=await db.query(`SELECT 1 FROM team_members tm JOIN memberships m ON m.org_id=tm.org_id AND m.user_id=tm.user_id JOIN users u ON u.id=tm.user_id
        WHERE tm.team_id=$1 AND tm.user_id=$2 AND tm.role='member' AND m.active AND m.role<>'guest' AND NOT u.disabled`,[team,b.userId]);
      if(!eligible.rowCount)throw new HttpError(404,'Eligible team member unavailable');
      await db.query("UPDATE team_members SET role='member' WHERE team_id=$1 AND role='owner'",[team]);
      await db.query("UPDATE team_members SET role='owner' WHERE team_id=$1 AND user_id=$2",[team,b.userId]);
      await audit(db,req.user.id,org,'team.ownership_recovered',team,{newOwner:b.userId,formerOwners:previous});return {ok:true,formerOwnersReset:previous.length};
    });
  });
  app.post('/v1/organizations/:id/teams/:team/transfer-ownership',async req=>{
    const org=idParam(req),team=idParam(req,'team'),b=z.object({userId:uuid,expectedOwners:z.array(uuid).min(1).max(1000).refine(v=>new Set(v).size===v.length,'Duplicate owner references')}).strict().parse(req.body);
    return transaction(async db=>{
      const t=(await db.query('SELECT archived FROM teams WHERE id=$1 AND org_id=$2 FOR UPDATE',[team,org])).rows[0];if(!t)throw new HttpError(404,'Team unavailable');
      await db.query('SELECT user_id FROM memberships WHERE org_id=$1 AND user_id=ANY($2::uuid[]) ORDER BY user_id FOR SHARE',[org,[req.user.id,b.userId]]);
      await member(db,req.user.id,org);
      const actor=(await db.query('SELECT role FROM team_members WHERE team_id=$1 AND user_id=$2',[team,req.user.id])).rows[0];
      if(!actor)throw new HttpError(404,'Team membership required');if(actor.role!=='owner')throw new HttpError(403,'Current team ownership required');
      if(t.archived)throw new HttpError(409,'Restore the team before transferring ownership');
      const owners=(await db.query("SELECT user_id FROM team_members WHERE team_id=$1 AND role='owner' ORDER BY user_id LIMIT 1001",[team])).rows.map(r=>r.user_id);
      if(JSON.stringify(owners)!==JSON.stringify([...b.expectedOwners].sort()))throw new HttpError(409,'Team owners changed. Refresh ownership before retrying.');
      if(b.userId===req.user.id)throw new HttpError(400,'Choose another eligible team member');
      const target=await db.query(`SELECT 1 FROM team_members tm JOIN memberships m ON m.org_id=tm.org_id AND m.user_id=tm.user_id JOIN users u ON u.id=tm.user_id
        WHERE tm.team_id=$1 AND tm.user_id=$2 AND tm.role='member' AND m.active AND m.role<>'guest' AND NOT u.disabled`,[team,b.userId]);
      if(!target.rowCount)throw new HttpError(404,'Eligible team member unavailable');
      await db.query("UPDATE team_members SET role=CASE WHEN user_id=$2 THEN 'owner' ELSE 'member' END WHERE team_id=$1 AND user_id=ANY($3::uuid[])",[team,b.userId,[req.user.id,b.userId]]);
      await audit(db,req.user.id,org,'team.ownership_transferred',team,{from:req.user.id,to:b.userId});return {ok:true};
    });
  });
}
