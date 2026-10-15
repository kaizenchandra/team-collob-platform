import type {FastifyInstance} from 'fastify';
import {createHash,randomUUID} from 'node:crypto';
import {transaction} from './db.ts';
import {member,audit,HttpError} from './security.ts';
import {idParam} from './server.ts';
import {auditFiltersSchema,validateAuditRange,auditScopeSQL,auditParameters} from './audit-search.ts';
const maxBytes=2*1024*1024;
export async function registerAuditExport(app:FastifyInstance){
  app.get('/v1/organizations/:id/audit/export',async(req,reply)=>{
    const org=idParam(req),result=await transaction(async db=>{
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,39040))',[`${org}:${req.user.id}`]);
      await db.query('SELECT user_id FROM memberships WHERE org_id=$1 AND user_id=$2 FOR SHARE',[org,req.user.id]);await member(db,req.user.id,org,true);
      const filters=auditFiltersSchema.parse(req.query);validateAuditRange(filters);
      const recent=Number((await db.query("SELECT count(*) FROM audit WHERE org_id=$1 AND actor_id=$2 AND action='audit.export_generated' AND created_at>now()-interval '1 minute'",[org,req.user.id])).rows[0].count);
      if(recent>=5){reply.header('Retry-After','60');throw new HttpError(429,'Audit export limit reached. Retry in a minute.');}
      const row=(await db.query(`WITH selected AS MATERIALIZED (
        SELECT a.id,json_build_object('id',a.id::text,'org_id',a.org_id,'actor_id',a.actor_id,'actor',u.name,'action',a.action,'target',a.target,'metadata',a.metadata,
          'created_at',to_char(a.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))::text value
        FROM audit a LEFT JOIN users u ON u.id=a.actor_id WHERE ${auditScopeSQL} ORDER BY a.id DESC LIMIT 1001
      ) SELECT count(*)::int count,coalesce(sum(octet_length(value)),0)::text bytes,
        CASE WHEN count(*)<=1000 AND coalesce(sum(octet_length(value)),0)<=${maxBytes-8192} THEN '['||coalesce(string_agg(value,',' ORDER BY id DESC),'')||']' ELSE NULL END content,
        to_char(statement_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') generated_at FROM selected`,auditParameters(org,filters))).rows[0];
      if(row.count>1000)throw new HttpError(413,'More than 1000 audit events match. Narrow the filters before exporting.');
      if(row.content===null)throw new HttpError(413,'Audit export exceeds 2 MiB. Narrow the filters before exporting.');
      const exportId=randomUUID(),header=JSON.stringify({format:'concord.audit.v1',exportId,organizationId:org,generatedAt:row.generated_at,filters,order:'id.desc',count:row.count}),content=Buffer.from(header.slice(0,-1)+',"items":'+row.content+'}\n');
      if(content.length>maxBytes)throw new HttpError(413,'Audit export exceeds 2 MiB. Narrow the filters before exporting.');
      const sha256=createHash('sha256').update(content).digest('hex');await audit(db,req.user.id,org,'audit.export_generated',exportId,{count:row.count,bytes:content.length,sha256});return {content,sha256,exportId};
    });
    return reply.header('Content-Type','application/json; charset=utf-8').header('Content-Disposition',`attachment; filename="audit-${result.exportId}.json"`).header('Cache-Control','private, no-store').header('Access-Control-Expose-Headers','X-Export-SHA256, Content-Disposition').header('X-Export-SHA256',result.sha256).send(result.content);
  });
}
