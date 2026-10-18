import type {FastifyInstance} from 'fastify';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {transaction,type DB} from './db.ts';
import {ownerTeamChannel} from './governance-channel.ts';
import {audit,event,HttpError} from './security.ts';
import {requireUnheld} from './preservation.ts';
import {idParam} from './server.ts';
async function policy(db:DB,id:string){return (await db.query('SELECT days,revision FROM channel_message_retention WHERE channel_id=$1',[id])).rows[0] as {days:number|null;revision:number}|undefined??{days:null,revision:0};}
async function hold(db:DB,id:string){return (await db.query('SELECT active,revision FROM channel_preservation WHERE channel_id=$1',[id])).rows[0] as {active:boolean;revision:number}|undefined??{active:false,revision:0};}
async function plan(db:DB,id:string,p:{days:number|null;revision:number},h:{active:boolean;revision:number},asOf:string){
  const rows=p.days!==null&&!h.active?(await db.query('SELECT id,created_at,row_to_json(m)::text snapshot FROM messages m WHERE channel_id=$1 AND NOT deleted AND created_at < $2::timestamptz - ($3::int*24)*interval \'1 hour\' ORDER BY created_at,id LIMIT 101',[id,asOf,p.days])).rows:[];
  const batch=rows.slice(0,100),hasMore=rows.length>100;
  const token=batch.length?createHash('sha256').update(JSON.stringify([id,p,h,asOf,hasMore,batch.map(r=>r.snapshot)])).digest('hex'):null;
  return {ids:batch.map(r=>r.id) as string[],preview:{id,days:p.days,policyRevision:p.revision,held:h.active,asOf,count:batch.length,hasMore,oldestAt:batch[0]?.created_at??null,newestAt:batch.at(-1)?.created_at??null,token}};
}
export async function registerMessageRetention(app:FastifyInstance){
  app.get('/v1/channels/:id/message-retention',async req=>transaction(async db=>{const id=idParam(req);await ownerTeamChannel(db,req.user.id,id);return {id,...await policy(db,id),held:(await hold(db,id)).active};}));
  app.put('/v1/channels/:id/message-retention',async req=>{
    const id=idParam(req),b=z.object({days:z.number().int().min(1).max(3650).nullable(),expectedRevision:z.number().int().nonnegative(),confirm:z.literal(true)}).strict().parse(req.body);
    return transaction(async db=>{
      const c=await ownerTeamChannel(db,req.user.id,id),old=await policy(db,id),held=(await hold(db,id)).active;
      if(old.revision!==b.expectedRevision)throw new HttpError(409,'Retention policy changed. Refresh before saving.');
      if(old.days===b.days)return {id,...old,held,changed:false};
      const revision=old.revision+1;await db.query('INSERT INTO channel_message_retention(channel_id,days,revision) VALUES($1,$2,$3) ON CONFLICT(channel_id) DO UPDATE SET days=EXCLUDED.days,revision=EXCLUDED.revision',[id,b.days,revision]);
      await audit(db,req.user.id,c.org_id,'channel.message_retention_changed',id,{days:b.days,revision});await event(db,c.org_id,id,'channel.updated');return {id,days:b.days,revision,held,changed:true};
    });
  });
  app.get('/v1/channels/:id/message-retention/preview',async req=>transaction(async db=>{const id=idParam(req);await ownerTeamChannel(db,req.user.id,id);const p=await policy(db,id),h=await hold(db,id);return (await plan(db,id,p,h,new Date().toISOString())).preview;}));
  app.post('/v1/channels/:id/message-retention/apply',async req=>{
    const id=idParam(req),b=z.object({expectedRevision:z.number().int().nonnegative(),asOf:z.iso.datetime(),token:z.string().regex(/^[a-f0-9]{64}$/),confirm:z.literal(true)}).strict().parse(req.body);
    return transaction(async db=>{
      const c=await ownerTeamChannel(db,req.user.id,id),p=await policy(db,id);await requireUnheld(db,id);
      if(p.days===null||p.revision!==b.expectedRevision)throw new HttpError(409,'Retention policy changed. Preview again before applying.');
      const now=Date.now(),at=Date.parse(b.asOf);if(at>now||at<now-600000)throw new HttpError(409,'Retention preview expired. Preview again before applying.');
      const batch=await plan(db,id,p,await hold(db,id),b.asOf);
      if(!batch.ids.length||batch.preview.token!==b.token)throw new HttpError(409,'Retention preview changed. Preview again before applying.');
      const r=await db.query("UPDATE messages SET body='',deleted=true WHERE channel_id=$1 AND id=ANY($2::uuid[]) AND NOT deleted RETURNING id",[id,batch.ids]);
      if(r.rowCount!==batch.ids.length)throw new HttpError(409,'Retention preview changed. Preview again before applying.');
      await db.query('DELETE FROM message_mentions WHERE message_id=ANY($1::uuid[])',[batch.ids]);
      for(const mid of batch.ids)await event(db,c.org_id,id,'message.deleted',{id:mid});
      await audit(db,req.user.id,c.org_id,'channel.message_retention_applied',id,{count:batch.ids.length,policyRevision:p.revision,asOf:b.asOf});return {ok:true,count:batch.ids.length,hasMore:batch.preview.hasMore};
    });
  });
}
