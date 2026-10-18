import {captureScanner} from './capture-scanner.mjs';
import {fileRetentionSnapshot} from './file-retention-backup.mjs';
import {exportImageArchive} from './image-archive.mjs';
import {retentionSnapshot} from './retention-backup.mjs';
import {preservationSnapshot} from './preservation-backup.mjs';
import {moderationSnapshot} from './moderation-backup.mjs';
import pg from 'pg';
import {calendarSnapshot} from './calendar-backup.mjs';
import {CompactEncrypt} from 'jose';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,stat,rm} from 'node:fs/promises';
import {command,sha,maxBytes,validateBackup} from './backup-common.mjs';
if(process.env.ALLOW_LOCAL_BACKUP!=='true')throw new Error('Set ALLOW_LOCAL_BACKUP=true for this loopback development backup');
const inspect=async name=>JSON.parse((await command('docker',['inspect',`concord-collaboration-${name}-1`])).toString())[0];
const source=await inspect('api');
if(!source.Config.Env.includes('NODE_ENV=development'))throw new Error('Only the local development deployment is supported');
const pool=new pg.Pool({connectionString:'postgres://concord:local-development-only@127.0.0.1:55432/concord',connectionTimeoutMillis:5000});
const db=await pool.connect();
const started=Date.now(),backupId=randomUUID();let scannerCapture;
try{
  scannerCapture=await captureScanner(backupId);
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const snapshot=(await db.query('SELECT pg_export_snapshot() id,transaction_timestamp() at')).rows[0];
  const files=(await db.query('SELECT id,org_id,channel_id,storage_key,bytes,sha256,storage_backend,object_key,object_bucket,state,revision_root,revision_number,lifecycle_revision FROM files ORDER BY id LIMIT 10001')).rows;
  if(files.length>10000)throw new Error("Local backup file-count limit exceeded");
  const counts={};for(const table of ['messages','memberships','files','message_attachments','file_scan_jobs'])counts[table]=Number((await db.query(`SELECT count(*) FROM ${table}`)).rows[0].count);
  const moderation=await moderationSnapshot(db);for(const [table,entry] of Object.entries(moderation))counts[table]=entry.count;
  const calendar=await calendarSnapshot(db);for(const [table,entry] of Object.entries(calendar))counts[table]=entry.count;
  const preservation=await preservationSnapshot(db);for(const [table,entry] of Object.entries(preservation))counts[table]=entry.count;
  const retention=await retentionSnapshot(db);for(const [table,entry] of Object.entries(retention))counts[table]=entry.count;
  const fileRetention=await fileRetentionSnapshot(db);for(const [table,entry] of Object.entries(fileRetention))counts[table]=entry.count;
  const exportCode=`import {storedBytes} from './services/core/file-content.ts';let input='';for await(const part of process.stdin){input+=part;if(input.length>16777216)throw new Error('Manifest too large');}const files=JSON.parse(input);let total=0;for(const f of files){const bytes=await storedBytes(f);total+=bytes.length;if(total>33554432)throw new Error('File backup exceeds local limit');f.data=bytes.toString('base64');}process.stdout.write(JSON.stringify(files));`;
  const [dump,exported]=await Promise.all([
    command('docker',['exec','concord-collaboration-postgres-1','pg_dump','-U','concord','-d','concord','-Fc','--snapshot',snapshot.id]),
    command('docker',['exec','-i','concord-collaboration-api-1','node','--input-type=module','-e',exportCode],JSON.stringify(files))
  ]);
  const data=validateBackup({version:7,retention,preservation,calendar,moderation,snapshotAt:snapshot.at.toISOString(),images:{api:source.Image,postgres:(await inspect('postgres')).Image,objects:(await inspect('object-store')).Image},counts,database:dump.toString('base64'),databaseSha:sha(dump),files:JSON.parse(exported.toString())});
  await db.query('COMMIT');
  const plaintext=Buffer.from(JSON.stringify(data));if(plaintext.length>maxBytes)throw new Error('Backup envelope exceeds64MiB local limit');
  await mkdir('.data/backups',{recursive:true,mode:0o700});await mkdir('.data/backup-keys',{recursive:true,mode:0o700});
  const keyPath='.data/backup-keys/local-core.key';let key;
  try{key=await readFile(keyPath);}catch(e){if(e.code!=='ENOENT')throw e;key=randomBytes(32);await writeFile(keyPath,key,{mode:0o600,flag:'wx'});}
  if(key.length!==32 || ((await stat(keyPath)).mode&0o077)!==0)throw new Error('Backup key must be32bytes and mode0600');
  const artifact=`.data/backups/core-${backupId}.jwe`,imagePins={},images={...data.images,scanner:scannerCapture.image};let imageArchive;
  try{
    for(const [role,id] of Object.entries(images)){const tag=`concord-backup-${role}:${backupId}`;await command('docker',['image','tag',id,tag]);imagePins[role]=tag;}
    imageArchive=await exportImageArchive({directory:'.data/backups',name:`core-images-${backupId}.bin`,images,key});
    const portable=validateBackup({...data,version:10,images,scanner:scannerCapture.manifest,imageArchive,fileRetention}),portablePlaintext=Buffer.from(JSON.stringify(portable));if(portablePlaintext.length>maxBytes)throw new Error('Backup envelope exceeds local limit');
    const encrypted=await new CompactEncrypt(portablePlaintext).setProtectedHeader({alg:'dir',enc:'A256GCM',cty:'application/concord-backup+json'}).encrypt(key);
    await writeFile(artifact,encrypted,{mode:0o600,flag:'wx'});
    console.log(JSON.stringify({artifact,imageArchive,imagePins,sha256:sha(encrypted),snapshotAt:data.snapshotAt,counts,bytes:encrypted.length,durationMs:Date.now()-started,keyStoredSeparately:true}));
  }catch(error){if(imageArchive)await rm(`.data/backups/${imageArchive.name}`,{force:true});for(const tag of Object.values(imagePins))await command('docker',['image','rm',tag]).catch(()=>{});throw error;}
}finally{if(scannerCapture)await command('docker',['image','rm',scannerCapture.tag]).catch(()=>{});await db.query('ROLLBACK').catch(()=>{});db.release();await pool.end();}
