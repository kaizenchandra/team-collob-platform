// Small bounded ustar writer: flat allowlisted files, no external tar dependency.
import {open} from 'node:fs/promises';
import {constants} from 'node:fs';
export async function transferFiles(docker,container,destination,files){
  if(!/^concord-restore-[a-f0-9]{8}-(objects|verify)$/.test(container)||!['/tmp','/app'].includes(destination)||files.length<1||files.length>8)throw new Error('Invalid restore transfer target');
  const chunks=[],seen=new Set();let total=0;
  for(const {source,name} of files){
    if(!/^[a-z][a-z0-9-]*\.(mjs|json)$/.test(name)||name.length>100||seen.has(name))throw new Error('Invalid restore transfer name');seen.add(name);
    const handle=await open(source,constants.O_RDONLY|constants.O_NOFOLLOW);let bytes;
    try{const stat=await handle.stat();if(!stat.isFile()||stat.size>1024*1024)throw new Error('Invalid restore transfer file');bytes=await handle.readFile();}finally{await handle.close();}
    total+=bytes.length;if(bytes.length>1024*1024||total>2*1024*1024)throw new Error('Restore transfer too large');
    const header=Buffer.alloc(512),string=(value,offset,length)=>header.write(value,offset,length,'ascii'),octal=(value,offset,length)=>string(value.toString(8).padStart(length-1,'0')+'\0',offset,length);
    string(name,0,100);octal(0o444,100,8);octal(0,108,8);octal(0,116,8);octal(bytes.length,124,12);octal(0,136,12);header.fill(32,148,156);string('0',156,1);string('ustar\0',257,6);string('00',263,2);
    const checksum=header.reduce((sum,b)=>sum+b,0);string(checksum.toString(8).padStart(6,'0')+'\0 ',148,8);
    chunks.push(header,bytes,Buffer.alloc((512-bytes.length%512)%512));
  }
  chunks.push(Buffer.alloc(1024));
  await docker(['cp','-',`${container}:${destination}/`],Buffer.concat(chunks));
}
