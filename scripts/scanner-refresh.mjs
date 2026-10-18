import {compactDecrypt} from 'jose';
import {validateBackup,maxBytes,sha} from './backup-common.mjs';
export async function decryptBackup(encrypted,key){
  if(Buffer.byteLength(encrypted)>maxBytes*2)throw new Error('Encrypted backup too large');
  const decoded=await compactDecrypt(encrypted,key,{keyManagementAlgorithms:['dir'],contentEncryptionAlgorithms:['A256GCM']});
  if(decoded.plaintext.length>maxBytes||decoded.protectedHeader.cty!=='application/concord-backup+json')throw new Error('Invalid backup envelope');
  return validateBackup(JSON.parse(Buffer.from(decoded.plaintext).toString()));
}
function canonical(value){if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';if(value!==null&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';return JSON.stringify(value);}
export function immutableBackupDigest(value){
  const {version,scanner,imageArchive,scannerRefresh,images,...data}=validateBackup(value);void version;void scanner;void imageArchive;void scannerRefresh;
  return sha('concord-scanner-refresh-data-v1\0'+canonical({...data,images:{api:images.api,postgres:images.postgres,objects:images.objects}}));
}
export async function verifyScannerRefresh(value,key){
  const backup=validateBackup(value);if(backup.version!==11)return false;
  const proof=backup.scannerRefresh;
  if(sha(proof.originEnvelope)!==proof.originSha256)throw new Error('Scanner refresh origin digest mismatch');
  const origin=await decryptBackup(proof.originEnvelope,key);
  if(origin.version!==10)throw new Error('Scanner refresh origin must be version10');
  if(immutableBackupDigest(backup)!==proof.immutableSha256||immutableBackupDigest(origin)!==proof.immutableSha256)throw new Error('Scanner refresh changed immutable backup data');
  if(proof.previousArtifactSha256===proof.originSha256&&proof.previousScannerImage!==origin.images.scanner)throw new Error('Scanner refresh previous image mismatch');
  return true;
}
export async function createScannerRefreshProof(encrypted,key,refreshedAt=new Date().toISOString()){
  const source=await decryptBackup(encrypted,key);if(![10,11].includes(source.version))throw new Error('Scanner refresh requires version10 or11');
  await verifyScannerRefresh(source,key);
  const originEnvelope=source.version===10?encrypted:source.scannerRefresh.originEnvelope;
  return {originEnvelope,originSha256:sha(originEnvelope),previousArtifactSha256:sha(encrypted),previousScannerImage:source.images.scanner,refreshedAt,immutableSha256:immutableBackupDigest(source)};
}
