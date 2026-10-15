import {createHash} from 'node:crypto';
export const calendarTables={meetings:['id'],meeting_series:['id'],meeting_attendees:['meeting_id','user_id'],calendar_versions:['org_id','user_id'],meeting_reminders:['meeting_id','user_id']};
export async function calendarSnapshot(db,version=4){
  await db.query("SET TIME ZONE 'UTC'");await db.query("SET DateStyle TO 'ISO, YMD'");
  const manifest={};
  for(const [table,keys] of Object.entries(calendarTables)){
    if(table==='meeting_reminders'&&version<4)continue;
    const rows=(await db.query(`SELECT row_to_json(t)::text data FROM (SELECT * FROM ${table} ORDER BY ${keys.join(',')} LIMIT 50001) t`)).rows;
    if(rows.length>50000)throw new Error('Calendar backup row limit exceeded');
    const hash=createHash('sha256');for(const row of rows)hash.update(row.data+'\n');manifest[table]={count:rows.length,sha256:hash.digest('hex')};
  }
  return manifest;
}
export async function verifyCalendarGraph(db,version=4){
  const broken=(await db.query(`SELECT s.id FROM meeting_series s LEFT JOIN meetings m ON m.series_id=s.id GROUP BY s.id
    HAVING count(m.id)<>s.count OR min(m.series_ordinal)<>1 OR max(m.series_ordinal)<>s.count
      OR bool_or(m.org_id<>s.org_id) OR bool_or(s.cancelled AND NOT m.cancelled) LIMIT 1`)).rows;
  if(broken.length)throw new Error('Restored series graph mismatch');
  if(version>=4&&(await db.query('SELECT r.meeting_id FROM meeting_reminders r WHERE NOT EXISTS(SELECT 1 FROM meeting_attendees a WHERE a.meeting_id=r.meeting_id AND a.user_id=r.user_id) LIMIT 1')).rowCount)throw new Error('Restored reminder attendee missing');
  if((await db.query('SELECT m.id FROM meetings m WHERE NOT EXISTS(SELECT 1 FROM meeting_attendees a WHERE a.meeting_id=m.id AND a.user_id=m.organizer_id) LIMIT 1')).rowCount)throw new Error('Restored meeting organizer missing');
}

export async function reminderFixtureRows(db,org){
  return (await db.query(`SELECT r.meeting_id,r.user_id,r.minutes,to_char(r.dismissed_start AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') dismissed_start FROM meeting_reminders r JOIN meetings m ON m.id=r.meeting_id WHERE m.org_id=$1 ORDER BY r.meeting_id,r.user_id`,[org])).rows;
}
