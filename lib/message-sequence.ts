import {z} from 'zod';

export const messageSequence=z.string().max(19).regex(/^(0|[1-9][0-9]*)$/).pipe(z.string().refine(value=>BigInt(value)<=BigInt('9223372036854775807'),'Sequence exceeds PostgreSQL bigint range'));
export const readSequence=z.union([messageSequence,z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).transform(String)]);
export const receiptSnapshot=z.object({receipts:z.array(z.object({user_id:z.uuid(),name:z.string().min(1).max(500),seq:messageSequence})).max(100)}).refine(value=>new Set(value.receipts.map(row=>row.user_id)).size===value.receipts.length,'Duplicate receipt identity');
export type SharedReceipt=z.infer<typeof receiptSnapshot>['receipts'][number];
export function sequenceBefore(a:string,b:string){return BigInt(messageSequence.parse(a))<BigInt(messageSequence.parse(b));}
export function readersAt(receipts:SharedReceipt[],sequence:string,authorId:string){
  const target=BigInt(messageSequence.parse(sequence));
  return receipts.filter(row=>row.user_id!==authorId&&BigInt(messageSequence.parse(row.seq))>=target).map(row=>row.name);
}
