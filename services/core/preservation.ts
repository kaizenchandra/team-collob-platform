import {ownerTeamChannel} from './governance-channel.ts';
import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {transaction,type DB} from './db.ts';
import {HttpError,audit,event} from './security.ts';
import {idParam} from './server.ts';
// Call only after acquiring the channel mutation lock.
export async function requireUnheld(db:DB,id:string){
  if((await db.query('SELECT 1 FROM channel_preservation WHERE channel_id=$1 AND active',[id])).rowCount)throw new HttpError(409,'This conversation has a preservation hold. Message edits, message removal and file deletion are blocked.');
}
async function snapshot(db:DB,id:string){return (await db.query('SELECT active,reason,revision FROM channel_preservation WHERE channel_id=$1',[id])).rows[0]??{active:false,reason:'',revision:0};}
export async function registerPreservation(app:FastifyInstance){
  app.get('/v1/channels/:id/preservation',async req=>transaction(async db=>{
    const id=idParam(req);await ownerTeamChannel(db,req.user.id,id);return {id,...await snapshot(db,id)};
  }));
  app.put('/v1/channels/:id/preservation',async req=>{
    const id=idParam(req),b=z.object({active:z.boolean(),reason:z.string().trim().max(500),expectedRevision:z.number().int().nonnegative(),confirm:z.literal(true)}).strict().refine(v=>!v.active||v.reason.length>0,{message:'A preservation reason is required',path:['reason']}).parse(req.body);
    return transaction(async db=>{
      const c=await ownerTeamChannel(db,req.user.id,id),old=await snapshot(db,id);
      if(old.revision!==b.expectedRevision)throw new HttpError(409,'Preservation settings changed. Refresh before confirming.');
      if(old.active===b.active&&old.reason===b.reason)return {id,...old,changed:false};
      const revision=old.revision+1;
      await db.query('INSERT INTO channel_preservation(channel_id,active,reason,revision) VALUES($1,$2,$3,$4) ON CONFLICT(channel_id) DO UPDATE SET active=EXCLUDED.active,reason=EXCLUDED.reason,revision=EXCLUDED.revision',[id,b.active,b.reason,revision]);
      await audit(db,req.user.id,c.org_id,'channel.preservation_changed',id,{active:b.active,revision});
      await event(db,c.org_id,id,'channel.updated');return {id,active:b.active,reason:b.reason,revision,changed:true};
    });
  });
}
