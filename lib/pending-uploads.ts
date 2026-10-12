import {z} from "zod";
export const uploadStorageKey="concord.pending-uploads.v1";
const records=z.array(z.object({userId:z.uuid(),channelId:z.uuid(),fingerprint:z.string().regex(/^[a-f0-9]{64}$/),clientId:z.uuid()})).max(32);
function read(storage:Storage){
  try{return records.parse(JSON.parse(storage.getItem(uploadStorageKey)??"[]"));}
  catch{throw new Error("Upload recovery data is unavailable. Clear pending sends in Help before uploading.");}
}
export function beginUpload(storage:Storage,userId:string,channelId:string,fingerprint:string){
  const items=read(storage),old=items.find(x=>x.userId===userId && x.channelId===channelId && x.fingerprint===fingerprint);
  if(old)return old.clientId;
  if(items.length>=32)throw new Error("Too many unconfirmed uploads. Reselect an earlier file to retry, or clear pending sends in Help.");
  const clientId=crypto.randomUUID();items.push({userId,channelId,fingerprint,clientId});
  const valid=records.parse(items);
  try{storage.setItem(uploadStorageKey,JSON.stringify(valid));}catch{throw new Error("Cannot preserve upload recovery data. Allow session storage before uploading.");}
  return clientId;
}
export function finishUpload(storage:Storage,clientId:string){
  const items=read(storage).filter(x=>x.clientId!==clientId);
  if(items.length)storage.setItem(uploadStorageKey,JSON.stringify(items));else storage.removeItem(uploadStorageKey);
}
