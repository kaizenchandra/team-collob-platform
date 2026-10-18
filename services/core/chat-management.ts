import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {pool,transaction} from './db.ts';
import {accessSQL,audit,channel,event,HttpError,member} from './security.ts';
import {idParam} from './server.ts';
export async function registerChatManagement(app:FastifyInstance){
  app.get('/v1/channels/:id/chat',async req=>{
    const result=await pool.query(`SELECT c.id,c.name,c.kind,c.revision,c.archived,
      (c.kind='group' AND EXISTS(SELECT 1 FROM memberships admin WHERE admin.org_id=c.org_id AND admin.user_id=$1 AND admin.active AND admin.role IN('owner','admin'))) can_manage,
      coalesce((SELECT json_agg(json_build_object('id',u.id,'name',u.name) ORDER BY u.name,u.id)
        FROM channel_members cm JOIN memberships m ON m.org_id=cm.org_id AND m.user_id=cm.user_id
        JOIN users u ON u.id=cm.user_id WHERE cm.channel_id=c.id AND m.active AND NOT u.disabled),'[]'::json) participants
      FROM channels c WHERE c.id=$2 AND c.kind IN('direct','group') AND ${accessSQL}`,[req.user.id,idParam(req)]);
    if(!result.rowCount)throw new HttpError(404,'Chat unavailable');
    return result.rows[0];
  });
  app.patch('/v1/channels/:id/group-name',async req=>{
    const b=z.object({name:z.string().trim().min(1).max(160),revision:z.number().int().positive()}).strict().parse(req.body),id=idParam(req);
    return transaction(async db=>{
      await channel(db,req.user.id,id,true);const c=await channel(db,req.user.id,id);
      if(c.kind!=='group')throw new HttpError(400,'Only group chats can be renamed here');
      if(c.archived)throw new HttpError(409,'This conversation is archived');
      if(c.revision!==b.revision)throw new HttpError(409,'Group changed. Refresh participants before retrying.');
      if(c.name===b.name)return {revision:c.revision};
      await db.query('UPDATE channels SET name=$2,revision=revision+1 WHERE id=$1',[id,b.name]);
      await audit(db,req.user.id,c.org_id,'group.renamed',id,{revision:c.revision+1});
      await event(db,c.org_id,id,'channel.updated');return {revision:c.revision+1};
    });
  });
  for(const method of ['PUT','DELETE'] as const){
    app.route({method,url:'/v1/channels/:id/group-members/:user',handler:async req=>{
      const id=idParam(req),user=idParam(req,'user').toLowerCase();
      const revision=z.number().int().positive();
      const b=(method==='PUT'?z.object({revision,history:z.literal('all-retained')}).strict():z.object({revision}).strict()).parse(req.body);
      return transaction(async db=>{
        await channel(db,req.user.id,id,true);const c=await channel(db,req.user.id,id);
        if(c.kind!=='group')throw new HttpError(400,'Only group chats support participant management');
        await member(db,req.user.id,c.org_id,true);
        if(c.archived)throw new HttpError(409,'This conversation is archived');
        if(c.revision!==b.revision)throw new HttpError(409,'Group changed. Refresh participants before retrying.');
        if(method==='DELETE'&&user===req.user.id)throw new HttpError(400,'Use Leave group to remove your own access');
        const present=!!(await db.query('SELECT 1 FROM channel_members WHERE channel_id=$1 AND user_id=$2',[id,user])).rowCount;
        if(method==='PUT'){
          const target=await db.query('SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.org_id=$1 AND m.user_id=$2 AND m.active AND NOT u.disabled',[c.org_id,user]);
          if(!target.rowCount)throw new HttpError(404,'Participant unavailable in this workspace');
          if(present)return {revision:c.revision,changed:false};
          if(Number((await db.query('SELECT count(*) FROM channel_members WHERE channel_id=$1',[id])).rows[0].count)>=100)throw new HttpError(409,'Group participant limit reached (100)');
          await db.query('INSERT INTO channel_members(org_id,channel_id,user_id) VALUES($1,$2,$3)',[c.org_id,id,user]);
        }else{
          if(!present)return {revision:c.revision,changed:false};
          await db.query('DELETE FROM channel_members WHERE channel_id=$1 AND user_id=$2',[id,user]);
          await db.query('DELETE FROM drafts WHERE channel_id=$1 AND user_id=$2',[id,user]);
          await db.query('DELETE FROM channel_preferences WHERE channel_id=$1 AND user_id=$2',[id,user]);
        }
        await db.query('UPDATE channels SET revision=revision+1 WHERE id=$1',[id]);
        await audit(db,req.user.id,c.org_id,method==='PUT'?'group.participant_added':'group.participant_removed',id,{userId:user,revision:c.revision+1,...(method==='PUT'?{history:'all-retained'}:{})});
        await event(db,c.org_id,id,'channel.updated');return {revision:c.revision+1,changed:true};
      });
    }});
  }
  app.post('/v1/channels/:id/leave-group',async req=>{
    z.object({}).strict().parse(req.body);const id=idParam(req);
    return transaction(async db=>{
      await channel(db,req.user.id,id,true);const c=await channel(db,req.user.id,id);
      if(c.kind!=='group')throw new HttpError(400,'Only group chats support leaving');
      await db.query('DELETE FROM channel_members WHERE channel_id=$1 AND user_id=$2',[id,req.user.id]);
      await db.query('DELETE FROM drafts WHERE channel_id=$1 AND user_id=$2',[id,req.user.id]);
      await db.query('DELETE FROM channel_preferences WHERE channel_id=$1 AND user_id=$2',[id,req.user.id]);
      await db.query('UPDATE channels SET revision=revision+1 WHERE id=$1',[id]);
      await audit(db,req.user.id,c.org_id,'group.left',id);
      await event(db,c.org_id,id,'channel.updated');return {ok:true};
    });
  });
}
