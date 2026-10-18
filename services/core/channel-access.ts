import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {transaction} from './db.ts';
import {channel,member,audit,event,HttpError} from './security.ts';
import {idParam} from './server.ts';
export async function registerChannelAccess(app:FastifyInstance){
  app.get('/v1/channels/:id/access',async req=>transaction(async db=>{
    const id=idParam(req);await channel(db,req.user.id,id,true);const c=await channel(db,req.user.id,id);await member(db,req.user.id,c.org_id,true);
    if(!['private','shared'].includes(c.kind))throw new HttpError(400,'Explicit access is available only for private and shared channels');
    const rows=(await db.query(`SELECT u.id,u.name,(m.active AND NOT u.disabled) active FROM channel_members cm
      JOIN memberships m ON m.org_id=cm.org_id AND m.user_id=cm.user_id JOIN users u ON u.id=cm.user_id
      WHERE cm.channel_id=$1 ORDER BY u.name,u.id LIMIT 1001`,[id])).rows;
    if(rows.length>1000)throw new HttpError(413,'Channel access view is limited to 1000 members');
    return {id:c.id,kind:c.kind,revision:c.revision,archived:c.archived,members:rows};
  }));
  for(const method of ['PUT','DELETE'] as const){
    app.route({method,url:'/v1/channels/:id/explicit-members/:user',handler:async req=>{
      const id=idParam(req),user=idParam(req,'user').toLowerCase(),revision=z.number().int().positive();
      const b=(method==='PUT'?z.object({revision,history:z.literal('all-retained')}).strict():z.object({revision}).strict()).parse(req.body);
      return transaction(async db=>{
        await channel(db,req.user.id,id,true);const c=await channel(db,req.user.id,id);await member(db,req.user.id,c.org_id,true);
        if(!['private','shared'].includes(c.kind))throw new HttpError(400,'Explicit access is available only for private and shared channels');
        if(c.archived)throw new HttpError(409,'This conversation is archived');
        if(c.revision!==b.revision)throw new HttpError(409,'Channel changed. Refresh channel access before retrying.');
        if(method==='DELETE'&&user===req.user.id)throw new HttpError(400,'You cannot remove your own channel access here');
        const present=!!(await db.query('SELECT 1 FROM channel_members WHERE channel_id=$1 AND user_id=$2',[id,user])).rowCount;
        if(method==='PUT'){
          if(!(await db.query('SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.org_id=$1 AND m.user_id=$2 AND m.active AND NOT u.disabled',[c.org_id,user])).rowCount)throw new HttpError(404,'Member unavailable in this workspace');
          if(present)return {revision:c.revision,changed:false};
          if(Number((await db.query('SELECT count(*) FROM channel_members WHERE channel_id=$1',[id])).rows[0].count)>=100)throw new HttpError(409,'Explicit channel member limit reached (100)');
          await db.query('INSERT INTO channel_members(org_id,channel_id,user_id) VALUES($1,$2,$3)',[c.org_id,id,user]);
        }else{
          if(!present)return {revision:c.revision,changed:false};
          await db.query('DELETE FROM channel_members WHERE channel_id=$1 AND user_id=$2',[id,user]);
          await db.query('DELETE FROM drafts WHERE channel_id=$1 AND user_id=$2',[id,user]);await db.query('DELETE FROM channel_preferences WHERE channel_id=$1 AND user_id=$2',[id,user]);
        }
        await db.query('UPDATE channels SET revision=revision+1 WHERE id=$1',[id]);
        await audit(db,req.user.id,c.org_id,method==='PUT'?'channel.member_added':'channel.member_removed',id,{userId:user,revision:c.revision+1,...(method==='PUT'?{history:'all-retained'}:{})});
        await event(db,c.org_id,id,'channel.updated');return {revision:c.revision+1,changed:true};
      });
    }});
  }
}
