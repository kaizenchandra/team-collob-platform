import {readFile} from 'node:fs/promises';
export async function assertWorkerHeartbeat(filename:string,maxAge:number,now=Date.now()){
  const raw=(await readFile(filename,'utf8')).trim(),timestamp=Number(raw),age=now-timestamp;
  if(!/^[1-9]\d*$/.test(raw)||!Number.isSafeInteger(timestamp)||!Number.isSafeInteger(now)||!Number.isSafeInteger(maxAge)||maxAge<=0||age < -5000||age>=maxAge)throw new Error('Invalid worker heartbeat');
}
