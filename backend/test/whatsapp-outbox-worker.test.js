const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createOutboxWorker} = require('../services/whatsapp/outboxWorker');
function clock(t) {
  let now=0;
  t.mock.method(Date,'now',()=>now);
  const pending=new Map(), intervals=new Map(); let seq=0;
  const timers={
    setTimeout(fn,delay){const id=++seq;pending.set(id,{fn,delay});return id;},
    clearTimeout(id){pending.delete(id);},
    setInterval(fn,delay){const id=++seq;intervals.set(id,{fn,delay});return id;},
    clearInterval(id){intervals.delete(id);},
  };
  const take=()=>{assert.equal(pending.size,1);const [id,task]=pending.entries().next().value;pending.delete(id);now+=task.delay;return task;};
  return {timers,pending,intervals,take};
}
test('outbox wakes at next turn, coalesces demand and never overlaps a live drain',async t=>{
  const c=clock(t);let calls=0,active=0,max=0,release;
  const worker=createOutboxWorker(async()=>{calls++;max=Math.max(max,++active);if(calls===1)await new Promise(r=>release=r);active--;},{timers:c.timers});
  const first=c.take();assert.equal(first.delay,0);
  const flight=first.fn();
  for(let i=0;i<100;i++)worker.wake();
  for(const timer of c.intervals.values())timer.fn();
  assert.equal(c.pending.size,0);assert.equal(calls,1);
  release();await flight;
  const follow=c.take();assert.equal(follow.delay,0);await follow.fn();
  assert.equal(calls,2);assert.equal(max,1);assert.equal(c.pending.size,0);
  assert.equal([...c.intervals.values()][0].delay,15000);
  worker.wake();assert.equal(c.take().delay,0);
  worker.stop();assert.equal(c.intervals.size,0);worker.wake();assert.equal(c.pending.size,0);
});
test('outbox failure throttles queued demand and cannot busy-loop while idle',async t=>{
  const c=clock(t);let release,calls=0,errors=0;
  const worker=createOutboxWorker(async()=>{calls++;if(calls===1)await new Promise(r=>release=r);throw Error('synthetic database interruption');},{timers:c.timers,onError:()=>errors++});
  const flight=c.take().fn();worker.wake();release();await flight;
  const retry=c.take();assert.equal(retry.delay,1000);await retry.fn();
  assert.equal(calls,2);assert.equal(errors,2);assert.equal(c.pending.size,0);
  for(const interval of c.intervals.values())interval.fn();
  assert.equal(c.pending.size,1);
  worker.stop();assert.equal(c.pending.size,0);assert.equal(c.intervals.size,0);
});
