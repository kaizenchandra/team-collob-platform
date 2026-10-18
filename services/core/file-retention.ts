import type {FastifyInstance} from 'fastify';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {transaction,type DB} from './db.ts';
import {ownerTeamChannel} from './governance-channel.ts';
import {audit,event,HttpError} from './security.ts';
import {requireUnheld} from './preservation.ts';
import {idParam} from './server.ts';
async function policy(db:DB,id:string){return (await db.query('SELECT days,revision FROM channel_file_retention WHERE channel_id=$1',[id])).rows[0] as {days:number|null;revision:number}|undefined??{days:null,revision:0};}
async function hold(db:DB,id:string){return (await db.query('SELECT active,revision FROM channel_preservation WHERE channel_id=$1',[id])).rows[0] as {active:boolean;revision:number}|undefined??{active:false,revision:0};}
async function plan(db:DB,id:string,p:{days:number|null;revision:number},h:{active:boolean;revision:number},asOf:string){
  const rows=p.days!==null&&!h.active?(await db.query(`SELECT r.id,max(f.created_at) newest_at,
    count(*) FILTER(WHERE f.state<>'deleted') active_count,
    sum(f.bytes) FILTER(WHERE f.state<>'deleted') bytes,
    array_agg(f.id ORDER BY f.id) FILTER(WHERE f.state<>'deleted') ids,
    json_agg(row_to_json(f) ORDER BY f.id)::text snapshot
    FROM files r JOIN files f ON f.id=r.id OR f.revision_root=r.id
    WHERE r.channel_id=$1 AND r.revision_root IS NULL AND r.state<>'deleted'
    GROUP BY r.id HAVING max(f.created_at)<$2::timestamptz-($3::int*24)*interval '1 hour'
    ORDER BY max(f.created_at),r.id LIMIT 101`,[id,asOf,p.days])).rows:[];
  const batch:typeof rows=[],ids:string[]=[];let bytes=0;
  for(const row of rows){const count=Number(row.active_count);if(count>100)throw new HttpError(409,'File family exceeds the supported retention batch limit');if(ids.length+count>100)break;batch.push(row);ids.push(...row.ids);bytes+=Number(row.bytes);}
  const hasMore=batch.length<rows.length;
  const token=ids.length?createHash('sha256').update(JSON.stringify([id,p,h,asOf,hasMore,batch.map(r=>r.snapshot)])).digest('hex'):null;
  return {ids,preview:{id,days:p.days,policyRevision:p.revision,held:h.active,asOf,count:ids.length,families:batch.length,bytes,hasMore,oldestAt:batch[0]?.newest_at??null,newestAt:batch.at(-1)?.newest_at??null,token}};
}
export async function registerFileRetention(app:FastifyInstance){
  app.get('/v1/channels/:id/file-retention',async req=>transaction(async db=>{const id=idParam(req);await ownerTeamChannel(db,req.user.id,id);return {id,...await policy(db,id),held:(await hold(db,id)).active};}));
  app.put('/v1/channels/:id/file-retention',async req=>{
    const id=idParam(req),b=z.object({days:z.number().int().min(1).max(3650).nullable(),expectedRevision:z.number().int().nonnegative(),confirm:z.literal(true)}).strict().parse(req.body);
    return transaction(async db=>{
      const c=await ownerTeamChannel(db,req.user.id,id),old=await policy(db,id),held=(await hold(db,id)).active;
      if(old.revision!==b.expectedRevision)throw new HttpError(409,'File retention policy changed. Refresh before saving.');
      if(old.days===b.days)return {id,...old,held,changed:false};
      const revision=old.revision+1;await db.query('INSERT INTO channel_file_retention(channel_id,days,revision) VALUES($1,$2,$3) ON CONFLICT(channel_id) DO UPDATE SET days=EXCLUDED.days,revision=EXCLUDED.revision',[id,b.days,revision]);
      await audit(db,req.user.id,c.org_id,'channel.file_retention_changed',id,{days:b.days,revision});await event(db,c.org_id,id,'channel.updated');return {id,days:b.days,revision,held,changed:true};
    });
  });
  app.get('/v1/channels/:id/file-retention/preview',async req=>transaction(async db=>{const id=idParam(req);await ownerTeamChannel(db,req.user.id,id);return (await plan(db,id,await policy(db,id),await hold(db,id),new Date().toISOString())).preview;}));
  app.post('/v1/channels/:id/file-retention/apply',async req=>{
    const id=idParam(req),b=z.object({expectedRevision:z.number().int().nonnegative(),asOf:z.iso.datetime(),token:z.string().regex(/^[a-f0-9]{64}$/),confirm:z.literal(true)}).strict().parse(req.body);
    return transaction(async db=>{
      const c=await ownerTeamChannel(db,req.user.id,id),p=await policy(db,id);await requireUnheld(db,id);
      if(p.days===null||p.revision!==b.expectedRevision)throw new HttpError(409,'File retention policy changed. Preview again before applying.');
      const now=Date.now(),at=Date.parse(b.asOf);if(at>now||at<now-600000)throw new HttpError(409,'File retention preview expired. Preview again before applying.');
      const batch=await plan(db,id,p,await hold(db,id),b.asOf);
      if(!batch.ids.length||batch.preview.token!==b.token)throw new HttpError(409,'File retention preview changed. Preview again before applying.');
      const r=await db.query("UPDATE files SET state='deleted',lifecycle_revision=lifecycle_revision+1 WHERE channel_id=$1 AND id=ANY($2::uuid[]) AND state<>'deleted' RETURNING id",[id,batch.ids]);
      if(r.rowCount!==batch.ids.length)throw new HttpError(409,'File retention preview changed. Preview again before applying.');
      await db.query("UPDATE file_scan_jobs SET status='cancelled',lease_id=NULL,lease_until=NULL WHERE file_id=ANY($1::uuid[])",[batch.ids]);
      await event(db,c.org_id,id,'file.deleted');
      await audit(db,req.user.id,c.org_id,'channel.file_retention_applied',id,{count:batch.ids.length,families:batch.preview.families,policyRevision:p.revision,asOf:b.asOf});return {ok:true,count:batch.ids.length,families:batch.preview.families,hasMore:batch.preview.hasMore};
    });
  });
}
