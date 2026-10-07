const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),{fork}=require('node:child_process');
const {POLICIES,budgetKey,createPublicLimiter}=require('../services/publicLimits');
const response=()=>({headers:{},set(k,v){this.headers[k]=v;return this;},status(n){this.code=n;return this;},json(body){this.body=body;return this;}});
test('Collective public budgets: PostgreSQL load, expiry and four processes',{timeout:60000},async t=>{
 const env=require('./helpers/postgres').testEnvironment(),db=require('../database');await db.ready;
 t.after(async()=>{await db.close();await env.cleanup();});
 const reset=()=>db.runAsync('DELETE FROM public_request_limits');
 async function seed(scope,context,hits){const p=POLICIES[scope],start=Math.floor(Date.now()/p.windowMs)*p.windowMs;await db.runAsync('INSERT INTO public_request_limits VALUES($1,$2,$3,$4)',[budgetKey(scope,p,context),start,hits,new Date(start+p.windowMs)]);}
 for(const scope of ['signup','navigationGlobal','bookingGlobal','reservationReadGlobal','confirmationRecoveryGlobal','cancellationGlobal']){
  await t.test(`${scope}: collective ceiling cannot be bypassed with new identities`,async()=>{
   await reset();await seed(scope,undefined,POLICIES[scope].limit-1);const limiter=createPublicLimiter(db,scope);
   const results=await Promise.all(Array.from({length:40},async(_,i)=>{const res=response();let ok=false;
    await limiter({ip:`192.0.2.${i}`,headers:{'x-forwarded-for':`198.51.100.${i}`},body:{token:String(i),chave:String(i)},params:{slug:String(i)}},res,()=>ok=true);
    if(!ok){assert.equal(res.code,429);assert.ok(Number(res.headers['Retry-After'])>0);assert.deepEqual(Object.keys(res.body),['error']);assert.doesNotMatch(JSON.stringify(res.body),/SELECT|key_hash|window_start/);}return ok;
   }));assert.equal(results.filter(Boolean).length,1);assert.equal((await db.getAsync('SELECT count(*)::int n FROM public_request_limits')).n,1);
  });
 }
 await t.test('multiple clients navigate one studio and different studios without premature blocking',async()=>{
  await reset();const global=createPublicLimiter(db,'navigationGlobal'),local=createPublicLimiter(db,'navigation');
  for(const tenantId of [1,2])await Promise.all(Array.from({length:400},async()=>{const res=response();assert.equal(await global.check(res),true);assert.equal(await local.check(res,{tenantId}),true);}));
  assert.equal((await db.getAsync('SELECT sum(hits)::int n FROM public_request_limits')).n,1600);
 });
 await t.test('catalogue and slots share the tenant budget; another tenant remains usable',async()=>{
  await reset();await seed('navigation',{tenantId:1},POLICIES.navigation.limit-1);
  const catalogue=createPublicLimiter(db,'navigation'),slots=createPublicLimiter(db,'navigation');
  assert.equal(await catalogue.check(response(),{tenantId:1}),true);const res=response();assert.equal(await slots.check(res,{tenantId:1}),false);assert.equal(res.code,429);
  assert.equal(await slots.check(response(),{tenantId:2}),true);
 });
 await t.test('normal bookings and new idempotency keys cannot escape tenant budgets',async()=>{
  await reset();const limiter=createPublicLimiter(db,'booking');
  for(const tenantId of [1,2])for(let i=0;i<40;i++)assert.equal(await limiter.check(response(),{tenantId}),true);
  await reset();await seed('booking',{tenantId:1},POLICIES.booking.limit-1);
  let accepted=0;for(let i=0;i<40;i++){if(await limiter.check(response(),{tenantId:1,key:String(i)}))accepted++;}assert.equal(accepted,1);
  assert.equal(await limiter.check(response(),{tenantId:2}),true);
 });
 await t.test('private valid budgets isolate reservations and operations; missing context fails closed',async()=>{
  await reset();const ctx={tenantId:1,reservationId:10};await seed('reservationRead',ctx,POLICIES.reservationRead.limit);
  const limiter=createPublicLimiter(db,'reservationRead');assert.equal(await limiter.check(response(),ctx),false);
  assert.equal(await limiter.check(response(),{tenantId:1,reservationId:11}),true);
  assert.equal(await createPublicLimiter(db,'confirmationRecovery').check(response(),ctx),true);
  const count=(await db.getAsync('SELECT count(*)::int n FROM public_request_limits')).n,res=response();assert.equal(await limiter.check(res,{token:'secret'}),false);assert.equal(res.code,503);assert.equal((await db.getAsync('SELECT count(*)::int n FROM public_request_limits')).n,count);
 });
 await t.test('expired counters are cleaned and a new window restores its budget',async sub=>{
  await reset();let now=1800000000000;sub.mock.method(Date,'now',()=>now);
  await db.runAsync('INSERT INTO public_request_limits VALUES($1,0,1,$2)',['f'.repeat(64),new Date(0)]);
  const limiter=createPublicLimiter(db,'collective-expiry',{limit:1,windowMs:60000});assert.equal(await limiter.check(response()),true);assert.equal(await limiter.check(response()),false);
  assert.equal((await db.getAsync('SELECT count(*)::int n FROM public_request_limits')).n,1);now+=60001;assert.equal(await limiter.check(response()),true);
 });
 await t.test('four independent processes share the same global budget atomically',async()=>{
  await reset();const outcomes=await Promise.all(Array.from({length:4},()=>new Promise((resolve,reject)=>{
   const child=fork(path.join(__dirname,'helpers/public-limit-worker.js'),[],{env:{...process.env},windowsHide:true,stdio:['ignore','ignore','ignore','ipc']});let result;
   child.on('message',r=>result=r);child.on('error',reject);child.on('exit',code=>code===0&&result?resolve(result):reject(Error('Worker failed')));
  })));
  assert.equal(outcomes.reduce((n,x)=>n+x.accepted,0),35);assert.equal(outcomes.reduce((n,x)=>n+x.limited,0),45);assert.equal((await db.getAsync('SELECT hits FROM public_request_limits')).hits,80);
 });
});
