import {z} from 'zod';
const key='concord:pending-call-chat';
const schema=z.array(z.object({user:z.uuid(),call:z.uuid(),room:z.uuid(),clientId:z.uuid(),body:z.string().min(1).max(4000),createdAt:z.number().finite()})).max(16);
type Store=Pick<Storage,'getItem'|'setItem'|'removeItem'>;
export type PendingCallChat=z.infer<typeof schema>[number];
function read(storage:Store){const raw=storage.getItem(key);if(!raw)return [];return schema.parse(JSON.parse(raw)).filter(r=>r.createdAt>Date.now()-86400000);}
export function pendingCallChat(storage:Store,user:string,call:string,room:string){return read(storage).find(r=>r.user===user&&r.call===call&&r.room===room)??null;}
export function saveCallChat(storage:Store,row:PendingCallChat){const rows=read(storage),old=rows.find(r=>r.user===row.user&&r.call===row.call&&r.room===row.room);if(old){if(old.clientId!==row.clientId||old.body!==row.body)throw new Error('Resolve the existing call message first');return;}storage.setItem(key,JSON.stringify(schema.parse([...rows,row])));}
export function acknowledgeCallChat(storage:Store,clientId:string){const rows=read(storage).filter(r=>r.clientId!==clientId);if(rows.length)storage.setItem(key,JSON.stringify(rows));else storage.removeItem(key);}
export function clearMeetingPending(storage:Store){storage.removeItem(key);}
