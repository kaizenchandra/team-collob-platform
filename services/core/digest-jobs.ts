import {randomUUID,randomInt} from 'node:crypto';
import {pool,transaction} from './db.ts';
import {accessSQL,audit} from './security.ts';
import {isQuietHours} from './notification-time.ts';
import {sendDigest,emailFailure,type DigestMail} from './email.ts';
export async function scheduleDigest(){
  return transaction(async db=>{
    const s=(await db.query(`SELECT s.* FROM notification_settings s JOIN users u ON u.id=s.user_id AND NOT u.disabled WHERE s.digest_enabled AND s.digest_checked_at<now()-interval '60 seconds' ORDER BY s.digest_checked_at FOR UPDATE OF s SKIP LOCKED LIMIT 1`)).rows[0];
    if(!s)return false;
    await db.query('UPDATE notification_settings SET digest_checked_at=now() WHERE user_id=$1',[s.user_id]);
    const rows=(await db.query(`SELECT m.id,c.org_id FROM messages m JOIN channels c ON c.id=m.channel_id
      LEFT JOIN read_positions r ON r.channel_id=c.id AND r.user_id=$1 LEFT JOIN channel_preferences p ON p.channel_id=c.id AND p.user_id=$1
      WHERE ${accessSQL} AND NOT m.deleted AND m.user_id<>$1 AND m.seq>coalesce(r.seq,0)
      AND NOT coalesce(p.muted,false) AND NOT coalesce(p.hidden,false) AND m.created_at>=$2 AND m.created_at>now()-interval '24 hours'
      AND NOT EXISTS(SELECT 1 FROM digest_items i WHERE i.user_id=$1 AND i.message_id=m.id)
      AND NOT EXISTS(SELECT 1 FROM digest_jobs j WHERE j.user_id=$1 AND j.org_id=c.org_id AND j.bucket=date_trunc('hour',now()))
      ORDER BY m.created_at,m.id LIMIT 100`,[s.user_id,s.digest_since])).rows;
    if(!rows.length)return false;
    const id=randomUUID(),org=rows[0].org_id;
    await db.query("INSERT INTO digest_jobs(id,user_id,org_id,bucket) VALUES($1,$2,$3,date_trunc('hour',now()))",[id,s.user_id,org]);
    for(const row of rows.filter(r=>r.org_id===org))await db.query('INSERT INTO digest_items(user_id,message_id,job_id) VALUES($1,$2,$3)',[s.user_id,row.id,id]);
    return true;
  });
}
export async function runDigestJob(send:(mail:DigestMail)=>Promise<void>=sendDigest){
  await pool.query("UPDATE digest_jobs SET state='uncertain',last_error='acceptance_unknown',lease_id=NULL,lease_until=NULL WHERE state='sending' AND lease_until<=now()");
  await pool.query("UPDATE digest_jobs SET state='dead',last_error='retry_exhausted',lease_id=NULL,lease_until=NULL WHERE state='preparing' AND lease_until<=now() AND attempts>=5");
  const lease=randomUUID();
  const job=(await pool.query(`UPDATE digest_jobs SET state='preparing',attempts=attempts+1,lease_id=$1,lease_until=now()+interval '90 seconds'
    WHERE id=(SELECT id FROM digest_jobs WHERE ((state='queued' AND available_at<=now()) OR (state='preparing' AND lease_until<=now())) AND attempts<5 ORDER BY available_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`,[lease])).rows[0];
  if(!job)return false;
  try{
    const pref=(await pool.query('SELECT s.*,u.email,u.timezone,u.disabled,o.name organization FROM notification_settings s JOIN users u ON u.id=s.user_id JOIN organizations o ON o.id=$2 WHERE s.user_id=$1',[job.user_id,job.org_id])).rows[0];
    if(!pref?.digest_enabled||pref.disabled){await pool.query("UPDATE digest_jobs SET state='cancelled',lease_id=NULL,lease_until=NULL WHERE id=$1 AND lease_id=$2",[job.id,lease]);return true;}
    if(pref.quiet_enabled&&isQuietHours(pref.timezone,pref.quiet_start,pref.quiet_end)){
      await pool.query("UPDATE digest_jobs SET state='queued',attempts=attempts-1,available_at=now()+interval '60 seconds',lease_id=NULL,lease_until=NULL WHERE id=$1 AND lease_id=$2",[job.id,lease]);return true;
    }
    const rows=(await pool.query(`SELECT c.kind FROM digest_items i JOIN messages m ON m.id=i.message_id JOIN channels c ON c.id=m.channel_id
      LEFT JOIN read_positions r ON r.channel_id=c.id AND r.user_id=$1 LEFT JOIN channel_preferences p ON p.channel_id=c.id AND p.user_id=$1
      WHERE i.job_id=$2 AND c.org_id=$3 AND ${accessSQL} AND NOT m.deleted AND m.user_id<>$1 AND m.seq>coalesce(r.seq,0)
      AND NOT coalesce(p.muted,false) AND NOT coalesce(p.hidden,false) AND m.created_at>=$4 AND m.created_at>now()-interval '24 hours'`,[job.user_id,job.id,job.org_id,pref.digest_since])).rows;
    if(!rows.length){await pool.query("UPDATE digest_jobs SET state='cancelled',lease_id=NULL,lease_until=NULL WHERE id=$1 AND lease_id=$2",[job.id,lease]);return true;}
    const intent=await pool.query("UPDATE digest_jobs SET state='sending' WHERE id=$1 AND lease_id=$2 AND state='preparing' AND lease_until>now() RETURNING id",[job.id,lease]);
    if(!intent.rowCount)return true;
    await send({id:job.id,to:pref.email,organization:pref.organization,orgId:job.org_id,count:rows.length,privateCount:rows.filter(r=>r.kind==='private').length});
    await transaction(async db=>{
      const changed=await db.query("UPDATE digest_jobs SET state='sent',accepted_at=now(),last_error=NULL,lease_id=NULL,lease_until=NULL WHERE id=$1 AND lease_id=$2 AND state='sending' RETURNING id",[job.id,lease]);
      if(changed.rowCount)await audit(db,job.user_id,job.org_id,'email.digest_accepted',job.id,{count:rows.length});
    });
  }catch(error){
    const kind=emailFailure(error),delay=Math.min(300,2**job.attempts)+randomInt(1,6);
    await pool.query("UPDATE digest_jobs SET state=$3,last_error=$4,available_at=now()+($5*interval '1 second'),lease_id=NULL,lease_until=NULL WHERE id=$1 AND lease_id=$2",[job.id,lease,kind==='retry'?(job.attempts>=5?'dead':'queued'):kind,kind==='uncertain'?'acceptance_unknown':'smtp_unavailable',delay]);
  }
  return true;
}
