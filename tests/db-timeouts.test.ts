import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {PoolClient} from 'pg';
import {pool,transaction} from '../services/core/db.ts';

test('transaction discards an uncertain timed-out connection instead of queueing rollback or reusing it',async()=>{
 const connect=pool.connect;
 try{
  for(const scenario of ['work-timeout','rollback-timeout','ordinary-error']){
   const timeout=new Error('Query read timeout'),failure=new Error('Statement failed'),commands:string[]=[];let released:Error|undefined,releaseCount=0;
   const client={query:async(sql:string)=>{commands.push(sql);if(sql==='work')throw scenario==='work-timeout'?timeout:failure;if(sql==='ROLLBACK'&&scenario==='rollback-timeout')throw timeout;},release:(error?:Error)=>{released=error;releaseCount++;}};
   pool.connect=(async()=>client as unknown as PoolClient) as typeof pool.connect;
   await assert.rejects(transaction(async db=>{await db.query('work');}),e=>e===(scenario==='work-timeout'?timeout:failure));
   assert.deepEqual(commands,scenario==='work-timeout'?['BEGIN','work']:['BEGIN','work','ROLLBACK']);assert.equal(releaseCount,1);assert.equal(released,scenario==='ordinary-error'?undefined:timeout);
  }
 }finally{pool.connect=connect;await pool.end();}
});
