import assert from 'node:assert/strict';
export async function verifyImageFixture(app,f,signin){
  const alice=await signin('alice@acme.test'),bob=await signin('bob@acme.test'),eve=await signin('eve@northstar.test');
  const get=(url,cookie)=>app.inject({url,headers:{cookie}}),base='/v1/channels/'+f.channel;
  const health=await app.inject({url:'/health'});assert.equal(health.statusCode,200);assert.equal(health.json().release,f.release);
  const history=await get(base+'/messages',bob);assert.equal(history.statusCode,200);const message=history.json().messages.find(m=>m.id===f.message);assert.equal(message.body,f.body);assert.deepEqual(message.attachments,[{id:f.file,name:f.name,state:'ready'}]);
  const file=await get(base+'/files/'+f.file+'/download',bob);assert.equal(file.statusCode,200);assert.equal(file.body,f.content);assert.equal((await get(base+'/messages',eve)).statusCode,404);assert.equal((await get(base+'/files/'+f.file+'/download',eve)).statusCode,404);
  const policy=await get(base+'/message-retention',alice);assert.equal(policy.statusCode,200);assert.deepEqual(policy.json(),{id:f.channel,days:null,revision:0,held:false});assert.equal((await get(base+'/message-retention',bob)).statusCode,403);
  return true;
}
