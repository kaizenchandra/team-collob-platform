import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {Temporal} from '@js-temporal/polyfill';
import {pool} from './db.ts';
import {member,HttpError} from './security.ts';
import {idParam} from './server.ts';
const cursor=z.string().refine(v=>/^[1-9][0-9]{0,18}$/.test(v)&&BigInt(v)<=BigInt('9223372036854775807'),'Use a positive PostgreSQL bigint audit cursor');
export const auditFiltersSchema=z.object({action:z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9._-]+$/).optional(),actor:z.uuid().optional(),target:z.string().trim().min(1).max(500).optional(),from:z.iso.datetime().optional(),to:z.iso.datetime().optional()}).strict();
type AuditFilters=z.infer<typeof auditFiltersSchema>;
export function validateAuditRange(q:AuditFilters){
  if(!!q.from!==!!q.to)throw new HttpError(400,'Provide both audit time bounds');
  if(q.from&&q.to){const span=Temporal.Instant.from(q.to).epochNanoseconds-Temporal.Instant.from(q.from).epochNanoseconds;if(span<=BigInt(0)||span>BigInt(366*86400)*BigInt(1000000000))throw new HttpError(400,'Audit time range must be positive and at most 366 days');}
}
export const auditScopeSQL=`a.org_id=$1 AND ($2::text IS NULL OR a.action=$2) AND ($3::uuid IS NULL OR a.actor_id=$3) AND ($4::text IS NULL OR a.target=$4) AND ($5::timestamptz IS NULL OR (a.created_at>=$5 AND a.created_at<$6::timestamptz))`;
export const auditParameters=(org:string,q:AuditFilters)=>[org,q.action??null,q.actor??null,q.target??null,q.from??null,q.to??null];
export async function registerAuditSearch(app:FastifyInstance){
  app.get('/v1/organizations/:id/audit',async req=>{
    const org=idParam(req);await member(pool,req.user.id,org,true);
    const q=auditFiltersSchema.extend({beforeId:cursor.optional(),limit:z.coerce.number().int().min(1).max(100).default(100)}).strict().parse(req.query);validateAuditRange(q);
    const rows=(await pool.query(`SELECT a.*,u.name actor FROM audit a LEFT JOIN users u ON u.id=a.actor_id
      WHERE ${auditScopeSQL} AND ($7::bigint IS NULL OR a.id<$7) ORDER BY a.id DESC LIMIT $8`,[...auditParameters(org,q),q.beforeId??null,q.limit+1])).rows;
    const items=rows.slice(0,q.limit);return {items,nextCursor:rows.length>q.limit?items.at(-1).id:null};
  });
}
