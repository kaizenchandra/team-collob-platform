import {z} from 'zod';
export const scannerFileName=z.string().max(80).regex(/^(?:(?:main|daily|bytecode)\.(?:cvd|cld)|(?:main|daily|bytecode)-[0-9]{1,10}\.cvd\.sign)$/);
export const scannerManifestSchema=z.object({sourceImage:z.string().regex(/^sha256:[a-f0-9]{64}$/),capturedAt:z.iso.datetime(),files:z.array(z.object({name:scannerFileName,bytes:z.number().int().positive().max(128*1024*1024),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict()).min(3).max(16)}).strict().superRefine((value,ctx)=>{
  if(new Set(value.files.map(f=>f.name)).size!==value.files.length||value.files.reduce((sum,f)=>sum+f.bytes,0)>256*1024*1024||!['main','daily','bytecode'].every(kind=>value.files.filter(f=>new RegExp('^'+kind+'\\.(cvd|cld)$').test(f.name)).length===1))ctx.addIssue({code:'custom',message:'Incomplete or excessive scanner databases'});
});
