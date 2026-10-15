import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {transaction,type DB} from './db.ts';
import {channel,member,HttpError,audit,event} from './security.ts';
import {idParam} from './server.ts';
export async function requirePosting(db:DB,user:string,c:{org_id:string;posting_restricted:boolean}){
  if(c.posting_restricted&&!['owner','admin'].includes((await member(db,user,c.org_id)).role))throw new HttpError(403,'Only workspace owners and admins can post or edit messages in this channel. Your draft is preserved.');
}
export async function registerPostingPolicy(app:FastifyInstance){
  app.patch('/v1/channels/:id/posting-policy',async req=>{
    const id=idParam(req),b=z.object({restricted:z.boolean(),revision:z.number().int().positive()}).strict().parse(req.body);
    return transaction(async db=>{
      const c=await channel(db,req.user.id,id,true);await member(db,req.user.id,c.org_id,true);
      if(!['standard','private','shared'].includes(c.kind))throw new HttpError(400,'Posting policy is available only for team channels');
      if(c.revision!==b.revision)throw new HttpError(409,'Channel changed. Refresh details before changing the posting policy.');
      if(c.posting_restricted===b.restricted)return {restricted:b.restricted,revision:c.revision};
      const row=(await db.query('UPDATE channels SET posting_restricted=$2,revision=revision+1 WHERE id=$1 RETURNING revision',[id,b.restricted])).rows[0];
      await audit(db,req.user.id,c.org_id,'channel.posting_policy_changed',id,{restricted:b.restricted});await event(db,c.org_id,id,'channel.updated',{id,revision:row.revision});
      return {restricted:b.restricted,revision:row.revision};
    });
  });
}
