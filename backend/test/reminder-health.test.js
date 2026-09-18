const {test}=require('node:test');
const assert=require('node:assert/strict');
const {startWorker,getWorkerStatus}=require('../services/reminders');

test('worker reports completed database cycles and failures without exposing errors',async()=>{
 let fail=false;
 const db={runAsync:async()=>{if(fail)throw Error('private connection detail');},transaction:async fn=>fn({runAsync:async()=>{},getAsync:async()=>null})};
 assert.equal(getWorkerStatus().startedAt,null);
 const timer=startWorker(db);
 try{
  await new Promise(resolve=>setImmediate(resolve));
  const first=getWorkerStatus();
  assert.ok(first.startedAt);assert.ok(first.lastCompletedAt);assert.equal(first.lastErrorAt,null);
  first.lastCompletedAt='changed';assert.notEqual(getWorkerStatus().lastCompletedAt,'changed');
  fail=true;
  await new Promise(resolve=>setTimeout(resolve,1100));
  assert.ok(getWorkerStatus().lastErrorAt);
  assert.equal(JSON.stringify(getWorkerStatus()).includes('private connection detail'),false);
  assert.equal(getWorkerStatus().running,false);
 }finally{clearInterval(timer);}
});
