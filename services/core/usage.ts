import type {FastifyInstance} from 'fastify';
import {transaction} from './db.ts';
import {member,accessSQL,audit} from './security.ts';
import {idParam} from './server.ts';
import {usageQuery,usageReport} from '../../lib/usage-contract.ts';

export async function registerUsage(app:FastifyInstance){
  app.get('/v1/organizations/:id/usage',async req=>{
    const org=idParam(req);
    return transaction(async db=>{
      await db.query('SELECT user_id FROM memberships WHERE org_id=$1 AND user_id=$2 FOR SHARE',[org,req.user.id]);
      await member(db,req.user.id,org,true);
      const q=usageQuery.parse(req.query);
      const result=(await db.query(`WITH authorized AS MATERIALIZED (
        SELECT c.id,c.archived FROM channels c WHERE c.org_id=$2 AND ${accessSQL}
      ), activity AS MATERIALIZED (
        SELECT m.user_id,(m.created_at AT TIME ZONE 'UTC')::date AS day FROM messages m JOIN authorized c ON c.id=m.channel_id
        WHERE m.org_id=$2 AND NOT m.deleted AND m.created_at >= $3::date::timestamp AT TIME ZONE 'UTC' AND m.created_at < $4::date::timestamp AT TIME ZONE 'UTC'
      ), scheduled AS MATERIALIZED (
        SELECT (m.starts_at AT TIME ZONE 'UTC')::date AS day,extract(epoch FROM m.ends_at-m.starts_at) seconds FROM meetings m
        WHERE m.org_id=$2 AND NOT m.cancelled AND (m.organizer_id=$1 OR EXISTS(SELECT 1 FROM meeting_attendees a WHERE a.meeting_id=m.id AND a.user_id=$1))
        AND m.starts_at >= $3::date::timestamp AT TIME ZONE 'UTC' AND m.starts_at < $4::date::timestamp AT TIME ZONE 'UTC'
      ), daily_activity AS (SELECT day,count(*)::text messages,count(DISTINCT user_id)::text authors FROM activity GROUP BY day),
      daily_meetings AS (SELECT day,count(*)::text meetings,sum(seconds)::text seconds FROM scheduled GROUP BY day),
      stock AS (SELECT count(*)::text versions,coalesce(sum(f.bytes),0)::text bytes FROM files f JOIN authorized c ON c.id=f.channel_id WHERE f.org_id=$2 AND f.state<>'deleted'),
      days AS (SELECT $3::date+i AS day FROM generate_series(0,$4::date-$3::date-1) i)
      SELECT json_build_object('organizationId',$2::uuid,'generatedAt',to_char(statement_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'scope','caller-authorized-resources','range',json_build_object('from',$3::text,'to',$4::text),
        'totals',json_build_object('channels',(SELECT count(*)::text FROM authorized),'archivedChannels',(SELECT count(*)::text FROM authorized WHERE archived),
          'messagesCreated',(SELECT count(*)::text FROM activity),'activeAuthors',(SELECT count(DISTINCT user_id)::text FROM activity),
          'registeredFileVersions',stock.versions,'registeredFileBytes',stock.bytes,
          'scheduledMeetings',(SELECT count(*)::text FROM scheduled),'scheduledSeconds',(SELECT coalesce(sum(seconds),0)::text FROM scheduled)),
        'daily',(SELECT json_agg(json_build_object('date',to_char(d.day,'YYYY-MM-DD'),'messagesCreated',coalesce(a.messages,'0'),'activeAuthors',coalesce(a.authors,'0'),
          'scheduledMeetings',coalesce(m.meetings,'0'),'scheduledSeconds',coalesce(m.seconds,'0')) ORDER BY d.day)
          FROM days d LEFT JOIN daily_activity a ON a.day=d.day LEFT JOIN daily_meetings m ON m.day=d.day)
      ) report FROM stock`,[req.user.id,org,q.from,q.to])).rows[0].report;
      const report=usageReport.parse(result);
      await audit(db,req.user.id,org,'usage.report_viewed',org,{from:q.from,to:q.to});
      return report;
    });
  });
}
