import {preflightBackup} from './backup-preflight.mjs';
if(process.env.ALLOW_LOCAL_BACKUP!=='true')throw new Error('Explicit local backup preflight opt-in required');
const [artifact,key=process.env.CONCORD_BACKUP_KEY_FILE||'.data/backup-keys/local-core.key',...extra]=process.argv.slice(2);
if(!artifact||extra.length)throw new Error('Usage: verify-backup.mjs BACKUP [KEY]');
console.log(JSON.stringify(await preflightBackup(artifact,key)));
