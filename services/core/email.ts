import nodemailer from 'nodemailer';
export type DigestMail={id:string;to:string;organization:string;orgId:string;count:number;privateCount:number};
export function emailConfiguration(env:Record<string,string|undefined>=process.env){
  if(!env.SMTP_HOST)throw new Error('SMTP is unconfigured');
  const local=env.SMTP_LOCAL_CAPTURE==='true';
  if(local && (env.NODE_ENV==='production'||env.SMTP_HOST!=='mailpit'))throw new Error('Local SMTP capture requires a development Mailpit host');
  if(!local && (!env.SMTP_USER||!env.SMTP_PASSWORD||!env.SMTP_FROM||!env.APP_PUBLIC_URL?.startsWith('https://')))throw new Error('Production SMTP requires credentials, sender and HTTPS application URL');
  const base=new URL(env.APP_PUBLIC_URL??'http://localhost:3101');
  if(base.username||base.password||!['http:','https:'].includes(base.protocol))throw new Error('Invalid application URL');
  const from=local?'notifications@concord.test':env.SMTP_FROM!;
  if(!/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(from))throw new Error('Invalid SMTP sender');
  const port=Number(env.SMTP_PORT??(local?1025:465));if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Invalid SMTP port');
  return {local,base,from,options:{host:env.SMTP_HOST,port,secure:!local,ignoreTLS:local,auth:local?undefined:{user:env.SMTP_USER!,pass:env.SMTP_PASSWORD!},connectionTimeout:10000,greetingTimeout:10000,socketTimeout:10000,disableFileAccess:true,disableUrlAccess:true}};
}
export async function sendDigest(mail:DigestMail){
  const config=emailConfiguration();
  if(!/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(mail.to)||(config.local&&!mail.to.endsWith('.test')))throw Object.assign(new Error('Recipient policy denied'),{definitive:true});
  const transport=nodemailer.createTransport(config.options);
  const link=new URL('/',config.base);link.searchParams.set('org',mail.orgId);
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{
    const sending=transport.sendMail({from:config.from,to:mail.to,messageId:`<digest-${mail.id}@${config.from.split('@')[1]}>`,subject:'Concord missed activity',text:`Workspace: ${mail.organization}\n\n${mail.count} unread messages, including ${mail.privateCount} in private channels.\n\nOpen your workspace: ${link}\n\nAccess is checked when you open the workspace. Message text and private channel names are omitted. Manage digest preferences in Settings.`});
    const result=await Promise.race([sending,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('SMTP deadline exceeded')),20000);})]);
    if(result.accepted.length!==1)throw Object.assign(new Error('Recipient rejected'),{definitive:true});
  }finally{clearTimeout(timer);transport.close();}
}
export function emailFailure(error:unknown):'retry'|'dead'|'uncertain'{
  const e=(error && typeof error==='object'?error:{}) as {code?:string;originalCode?:string;syscall?:string;command?:string;responseCode?:number;definitive?:boolean};
  if(e.definitive||Number(e.responseCode)>=500)return 'dead';
  if((Number(e.responseCode)>=400&&Number(e.responseCode)<500)||(e.command==='CONN'&&(e.code==='EDNS'||(e.code==='ESOCKET'&&e.originalCode==='ECONNREFUSED'&&e.syscall==='connect'))))return 'retry';
  return 'uncertain';
}
