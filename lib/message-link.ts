import {z} from 'zod';
const uuid=z.uuid().transform(value=>value.toLowerCase());
const target=z.object({org:uuid,channel:uuid,id:uuid});
export type MessageLinkTarget=z.infer<typeof target>;
export function readMessageLink(href:string):MessageLinkTarget|null{
  try{
    const url=new URL(href);
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.searchParams.getAll('org').length!==1||url.searchParams.getAll('channel').length!==1||!url.hash.startsWith('#message-'))return null;
    const parsed=target.safeParse({org:url.searchParams.get('org'),channel:url.searchParams.get('channel'),id:url.hash.slice('#message-'.length)});
    return parsed.success?parsed.data:null;
  }catch{return null;}
}
export function messageLink(origin:string,value:MessageLinkTarget){
  const parsed=target.parse(value),url=new URL('/',origin);
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('Invalid message link origin');
  url.search=new URLSearchParams({org:parsed.org,channel:parsed.channel}).toString();url.hash='message-'+parsed.id;
  return url.href;
}
