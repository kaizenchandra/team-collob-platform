import { createConnection } from "node:net";
export type ScanVerdict = {state:"ready"|"rejected"; version:string};
function command(host:string,port:number,command:string,body?:Buffer):Promise<string> {
  return new Promise((resolve,reject)=>{
    const socket=createConnection({host,port});
    let answer=Buffer.alloc(0),finished=false;
    const timer=setTimeout(()=>finish(new Error("Scanner deadline exceeded")),20000);
    function finish(error?:Error,value?:string) {if(finished)return;finished=true;clearTimeout(timer);socket.destroy();if(error)reject(error);else resolve(value!);}
    socket.on("error",()=>finish(new Error("Scanner connection unavailable")));
    socket.on("close",()=>{if(!finished)finish(new Error("Scanner returned an incomplete response"));});
    socket.on("connect",()=>{
      socket.write(`n${command}\n`);
      if(body){ if(body.length){const size=Buffer.alloc(4);size.writeUInt32BE(body.length);socket.write(size);socket.write(body);}socket.write(Buffer.alloc(4)); }
    });
    socket.on("data",part=>{
      answer=Buffer.concat([answer,part]);
      if(answer.length>4096)return finish(new Error("Scanner response exceeded limit"));
      if(answer.includes(10))finish(undefined,answer.toString("utf8").trim());
    });
  });
}
export async function scanWithClamav(bytes:Buffer):Promise<ScanVerdict> {
  const host=process.env.CLAMAV_HOST,port=Number(process.env.CLAMAV_PORT??3310);
  if(!host || !Number.isInteger(port) || port<1 || port>65535)throw new Error("Scanner not configured");
  if(bytes.length>1048576)throw new Error("Scan input too large");
  const info=await command(host,port,"VERSIONCOMMANDS");
  if(!info.includes("INSTREAM"))throw new Error("Scanner streaming protocol unavailable");
  const version=info.split(/\|?\s*COMMANDS:/)[0].trim();
  const date=Date.parse(version.split("/").slice(2).join("/")+" UTC");
  if(!Number.isFinite(date) || Date.now()-date>7*86400000 || date>Date.now()+86400000)throw new Error("Scanner signatures are stale or unverifiable");
  const result=await command(host,port,"INSTREAM",bytes);
  if(result==="stream: OK")return {state:"ready",version:version.slice(0,200)};
  if(/^stream: .+ FOUND$/.test(result))return {state:"rejected",version:version.slice(0,200)};
  throw new Error("Scanner did not return a definitive verdict");
}
