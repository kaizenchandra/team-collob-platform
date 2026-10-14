import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer,type Socket} from 'node:net';
import {once} from 'node:events';
import {probeClamav,scanWithClamav} from '../services/core/clamav.ts';

const version=(offset=0)=>`ClamAV test/123/${new Date(Date.now()+offset).toUTCString().replace(' GMT','')}| COMMANDS: VERSIONCOMMANDS INSTREAM\n`;
async function peer(reply:(socket:Socket,data:Buffer)=>void,check:()=>Promise<void>){
  const sockets=new Set<Socket>();
  const server=createServer(socket=>{sockets.add(socket);socket.on('error',()=>{});socket.on('close',()=>sockets.delete(socket));socket.on('data',data=>reply(socket,data));});
  const previous={host:process.env.CLAMAV_HOST,port:process.env.CLAMAV_PORT};
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const address=server.address();assert.ok(address&&typeof address!=='string');
  process.env.CLAMAV_HOST='127.0.0.1';process.env.CLAMAV_PORT=String(address.port);
  try{await check();}finally{
    for(const socket of sockets)socket.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));
    if(previous.host===undefined)delete process.env.CLAMAV_HOST;else process.env.CLAMAV_HOST=previous.host;
    if(previous.port===undefined)delete process.env.CLAMAV_PORT;else process.env.CLAMAV_PORT=previous.port;
  }
}
test('scanner probe accepts a fragmented current capability response',async()=>{
  await peer((socket,data)=>{assert.equal(data.toString(),'nVERSIONCOMMANDS\n');const response=version();socket.write(response.slice(0,8));setImmediate(()=>socket.end(response.slice(8)));},async()=>{assert.match(await probeClamav(1000),/^ClamAV test\/123\//);});
});
test('scanner probe rejects stale, future, missing and invalid signature metadata',async()=>{
  for(const response of [version(-8*86400000),version(2*86400000),'ClamAV test/123/invalid| COMMANDS: INSTREAM\n','ClamAV test| COMMANDS: INSTREAM\n']){
    await peer(socket=>socket.end(response),async()=>{await assert.rejects(probeClamav(1000),/stale or unverifiable/);});
  }
});
test('scanner probe rejects unsupported protocol, oversized and incomplete responses',async()=>{
  for(const [response,error] of [[version().replace('INSTREAM','PING'),/protocol unavailable/],['x'.repeat(4097),/exceeded limit/],['partial',/incomplete response/]] as const){
    await peer(socket=>socket.end(response),async()=>{await assert.rejects(probeClamav(1000),error);});
  }
});
test('scanner probe enforces a deadline and validates timeout configuration',async()=>{
  await peer(()=>{},async()=>{await assert.rejects(probeClamav(30),/deadline exceeded/);await assert.rejects(probeClamav(0),/Invalid scanner deadline/);await assert.rejects(probeClamav(20001),/Invalid scanner deadline/);});
});
test('scanner sends framed bytes only after readiness and accepts only definitive verdicts',async()=>{
  const bytes=Buffer.from('controlled protocol fixture');
  for(const [verdict,state] of [['stream: OK','ready'],['stream: Test.Signature FOUND','rejected'],['stream: UNKNOWN',null]] as const){
    const received=new Map<Socket,Buffer>();
    await peer((socket,data)=>{
      const all=Buffer.concat([received.get(socket)??Buffer.alloc(0),data]);received.set(socket,all);
      if(all.toString().startsWith('nVERSIONCOMMANDS\n')){socket.end(version());return;}
      const prefix=Buffer.from('nINSTREAM\n');if(all.length<prefix.length+4+bytes.length+4)return;
      assert.deepEqual(all.subarray(0,prefix.length),prefix);assert.equal(all.readUInt32BE(prefix.length),bytes.length);
      assert.deepEqual(all.subarray(prefix.length+4,-4),bytes);assert.equal(all.readUInt32BE(all.length-4),0);socket.end(verdict+'\n');
    },async()=>{if(state)assert.equal((await scanWithClamav(bytes)).state,state);else await assert.rejects(scanWithClamav(bytes),/definitive verdict/);});
  }
});
