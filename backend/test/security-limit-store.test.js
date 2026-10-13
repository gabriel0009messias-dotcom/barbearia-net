const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {fork}=require('node:child_process');
const path=require('node:path');
const {createSecurityLimits,POLICIES,BUCKETS}=require('../services/securityLimits');
function response(){return {statusCode:200,headers:{},body:null,set(k,v){this.headers[k]=v;return this;},status(n){this.statusCode=n;return this;},json(v){this.body=v;return this;}};}
test('Etapa 5: armazenamento compartilhado atomico, limitado e fail-closed',async t=>{
  const env=require('./helpers/postgres').testEnvironment(),db=require('../database');await db.ready;t.after(async()=>{await db.close();await env.cleanup();});
  const limiter=createSecurityLimits(db),identity=()=>crypto.randomUUID()+'@example.test';
  const worker=(scope,id,count)=>new Promise((resolve,reject)=>{
    const child=fork(path.join(__dirname,'helpers/security-limit-worker.js'),[scope,id,String(count)],{env:{...process.env},windowsHide:true,silent:true});
    let message;child.on('message',m=>message=m);child.on('error',reject);child.stdout.resume();child.stderr.resume();child.on('exit',code=>code===0&&message?resolve(message.results):reject(Error('Isolated worker failed')));
  });
  await t.test('quota real sob concorrencia: somente vinte de quarenta sao admitidos',async()=>{
    const id=identity(),results=await Promise.all(Array.from({length:40},async()=>{const res=response();await limiter.check(res,'ownerLogin',id);return res;}));
    assert.equal(results.filter(r=>r.statusCode===200).length,20);assert.equal(results.filter(r=>r.statusCode===429).length,20);
    const denied=results.find(r=>r.statusCode===429);assert.ok(Number(denied.headers['Retry-After'])>=1);assert.ok(Number(denied.headers['Retry-After'])<=300);assert.equal(denied.headers['Cache-Control'],'no-store');
    const row=await db.getAsync('SELECT * FROM public_request_limits WHERE key_hash=$1',[await limiter.budgetKey('ownerLogin',id)]);assert.equal(row.hits,21);
    const seconds=await db.getAsync('SELECT ceil(extract(epoch FROM ($1::timestamptz-clock_timestamp())))::int AS remaining',[row.expires_at]);assert.ok(Math.abs(Number(denied.headers['Retry-After'])-seconds.remaining)<=2);
  });
  await t.test('processos independentes e reinicio logico compartilham contador e segredo',async()=>{
    const id=identity(),results=(await Promise.all([worker('adminLogin',id,15),worker('adminLogin',id,15)])).flat();
    assert.equal(results.filter(n=>n===200).length,20);assert.equal(results.filter(n=>n===429).length,10);
    assert.deepEqual(await worker('adminLogin',id,1),[429]);
    const restart=createSecurityLimits(db),res=response();await restart.check(res,'adminLogin',id);assert.equal(res.statusCode,429);
    assert.equal(await restart.budgetKey('adminLogin',id),await limiter.budgetKey('adminLogin',id));
    assert.equal((await db.getAsync("SELECT COUNT(*)::int AS n FROM configuracoes WHERE chave='security_limit_key_v1'")).n,1);
  });
  await t.test('identidades arbitrarias usam conjunto fixo de buckets sem armazenar identidade',async()=>{
    const keys=new Set();for(let n=0;n<25000;n++)keys.add(await limiter.budgetKey('checkoutPassword','fake-'+n));assert.ok(keys.size<=BUCKETS);assert.ok(keys.size>BUCKETS/2);
    for(let n=0;n<100;n++)await limiter.check(response(),'checkoutPassword','fake-'+n);
    const all=await db.allAsync('SELECT * FROM public_request_limits');assert.ok(all.length<BUCKETS);
    for(const row of all){assert.match(row.key_hash,/^[a-f0-9]{64}$/);assert.ok(!JSON.stringify(row).includes('fake-'));}
    assert.equal(await limiter.budgetKey('ownerLogin','x'.repeat(255)),await limiter.budgetKey('ownerLogin','invalid'));
  });
  await t.test('clock do host nao altera janela PostgreSQL; limpeza remove expirados',async sub=>{
    const id=identity(),key=await limiter.budgetKey('recoveryStatus',id);await limiter.check(response(),'recoveryStatus',id);
    const before=await db.getAsync('SELECT * FROM public_request_limits WHERE key_hash=$1',[key]);let hostNow=0;sub.mock.method(Date,'now',()=>hostNow);
    await limiter.check(response(),'recoveryStatus',id);const after=await db.getAsync('SELECT * FROM public_request_limits WHERE key_hash=$1',[key]);assert.equal(after.window_start,before.window_start);assert.equal(after.hits,2);
    const expired='a'.repeat(64);await db.runAsync("INSERT INTO public_request_limits(key_hash,window_start,hits,expires_at) VALUES($1,1,1,'2000-01-01')",[expired]);await limiter.check(response(),'recoveryStatus',id);assert.equal(await db.getAsync('SELECT * FROM public_request_limits WHERE key_hash=$1',[expired]),undefined);
    hostNow=Date.parse('2199-01-01T00:00:00Z');await require('../services/publicLimits').createPublicLimiter(db,'signup').check(response());
    assert.equal((await db.getAsync('SELECT * FROM public_request_limits WHERE key_hash=$1',[key])).hits,3,'Public cleanup cannot erase live security counters when host clock is ahead');
  });
  await t.test('erro de contador, erro de cleanup e contador corrompido negam com 503',async()=>{
    for(const fake of [
      {getAsync:async()=>{throw Error('sensitive-body-password-token');}},
      {getAsync:async()=>({hits:1,retry:10}),runAsync:async()=>{throw Error('sensitive-cookie');}},
      {getAsync:async()=>({hits:-1,retry:10}),runAsync:async()=>{}},
    ]){
      const store={getAsync:db.getAsync,transaction:async fn=>fn(fake)},res=response();
      assert.equal(await createSecurityLimits(store).check(res,'ownerLogin',identity()),false);assert.equal(res.statusCode,503);assert.equal(res.headers['Retry-After'],'5');assert.doesNotMatch(JSON.stringify(res),/sensitive/);
    }
    const res=response();assert.equal(await createSecurityLimits({getAsync:async()=>{throw Error('secret-storage');}}).check(res,'ownerLogin',identity()),false);assert.equal(res.statusCode,503);
  });
});
