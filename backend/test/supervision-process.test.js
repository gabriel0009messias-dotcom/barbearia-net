const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fork, execFile } = require('node:child_process');
const path = require('node:path');
const { randomUUID, randomBytes } = require('node:crypto');
const { startSupervisor } = require('../supervisor');
const { channel, PROFILE, VERSION } = require('../services/supervision/protocol');
const delay = ms => new Promise(resolve => setTimeout(resolve,ms));
const deferred = () => { let resolve; const promise=new Promise(r=>{resolve=r;});return {promise,resolve}; };
function waitEvent(s,type) { return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Missing event '+type)),6000);const listener=e=>{if(e.type===type){clearTimeout(timer);s.events.off('event',listener);resolve(e);}};s.events.on('event',listener);}); }
function start(t,opts={}) {
  const calls=[],events=[];
  const authority={localTestOnly:true,enrollBirth:async()=>{calls.push('enroll');},openGate:async()=>{calls.push('open');},beginDraining:async()=>{calls.push('drain');},...opts.authority};
  const s=startSupervisor({environment:{NODE_ENV:'test',PORT:'0'},heartbeatMs:50,heartbeatTimeoutMs:600,handshakeTimeoutMs:4000,...opts,authority,onEvent:e=>{events.push(e);opts.onEvent?.(e);}});
  let output='';s.child.stdout.on('data',d=>{output+=d;});s.child.stderr.on('data',d=>{output+=d;});
  t.after(async()=>{s.shutdown();await s.done;});return {s,calls,events,output:()=>output};
}
test('real fixed child, fake enrollment, authenticated ACK and local health',async t=>{
  const held=deferred(),entered=deferred();
  const {s,calls,events,output}=start(t,{environment:{NODE_ENV:'test',PORT:'0',PROOF_DATABASE_URL:'synthetic-only',MIGRATION_DATABASE_URL:'synthetic-only',NODE_OPTIONS:'--require=never',npm_config_registry:'synthetic-only',LD_PRELOAD:'synthetic-only',LD_LIBRARY_PATH:'synthetic-only'},authority:{enrollBirth:async()=>{entered.resolve();await held.promise;}}});
  await entered.promise;await delay(100);
  assert.equal(s.snapshot().state,'ENROLLING');assert.equal(events.some(e=>e.type==='ready'),false);assert.doesNotMatch(output(),/"type":"ack"/);
  assert.equal(s.child.spawnargs.some(arg=>arg==='--inspect'),false);
  const ready=waitEvent(s,'ready');held.resolve();const event=await ready;
  assert.equal(events.find(e=>e.type==='hello').pid,s.child.pid);assert.deepEqual(calls,['open']);
  const response=await fetch('http://127.0.0.1:'+event.port+'/health');const body=await response.json();
  assert.equal(response.status,200);assert.equal(body.ok,true);assert.equal(body.pid,s.child.pid);
  for(const name of ['PROOF_DATABASE_URL','MIGRATION_DATABASE_URL','NODE_OPTIONS','npm_config_registry','LD_PRELOAD','LD_LIBRARY_PATH'])assert.equal(body.envKeys.includes(name),false,name);
  assert.deepEqual(body.effects,{listener:1,worker:1,timer:1,booking:0,webhook:0,conversation:0,database:0,migration:0});
  await waitEvent(s,'heartbeat');assert.equal(s.snapshot().proof,false);assert.equal(s.snapshot().persistentGate,false);
  s.shutdown();const done=await s.done;assert.equal(done.proof,false);assert.ok(done.exit);assert.equal(done.closed,true);
});
for(const point of ['starting','hello','enrolled','before-ack','ack'])test('shutdown at '+point+' never grants a later startup',async t=>{
  let s;const record=[];
  const launched=start(t,{onEvent:e=>{record.push(e);if(e.type===point)process.emit('SIGTERM');}});s=launched.s;
  await s.done;assert.equal(record.some(e=>e.type==='ready'),false);assert.equal(s.snapshot().proof,false);
});
test('shutdown while enrollment/open awaits cannot send ACK after resolution',async t=>{
  for(const operation of ['enrollBirth','openGate']) {
    const held=deferred(),entered=deferred();const {s,events}=start(t,{authority:{[operation]:async()=>{entered.resolve();await held.promise;}}});
    await entered.promise;s.shutdown();held.resolve();await s.done;await delay(10);
    assert.equal(events.some(e=>e.type==='ack'),false);assert.equal(events.some(e=>e.type==='ready'),false);
  }
});
test('child events do not manufacture exit or proof',async t=>{
  const {s,events}=start(t);await waitEvent(s,'ready');
  s.child.emit('error',Error('synthetic operation failure'));
  assert.equal(s.snapshot().exit,null);assert.equal(s.snapshot().proof,false);
  const done=await s.done;assert.ok(done.exit);assert.ok(events.some(e=>e.type==='child-error'));assert.ok(events.some(e=>e.type==='exit'));assert.ok(events.some(e=>e.type==='close'));
});
test('HELLO duplicate is idempotent, while PID mismatch and conflicting duplicates fail closed',async t=>{
  for(const mode of ['duplicate','pid','conflict']) {
    const held=deferred();let calls=0;
    const {s,events}=start(t,{authority:{enrollBirth:async()=>{calls++;await held.promise;}}});
    let message;
    s.child.prependOnceListener('message',m=>{message=m;if(mode==='pid')m.pid++;});
    if(mode==='pid'){await s.done;assert.equal(calls,0);continue;}
    await waitEvent(s,'hello');
    s.child.emit('message',mode==='duplicate'?{...message}:{...message,auth:'0'.repeat(64)});
    if(mode==='duplicate'){const ready=waitEvent(s,'ready');held.resolve();await ready;assert.equal(calls,1);}
    else {held.resolve();await s.done;assert.equal(events.some(e=>e.type==='ready'),false);}
    held.resolve();s.shutdown();await s.done;
  }
});
test('failed enrollment/open and handshake deadline never admit business',async t=>{
  for(const operation of ['enrollBirth','openGate']) {
    const {s,events}=start(t,{authority:{[operation]:async()=>{throw Error('synthetic unavailable');}}});
    await s.done;assert.equal(events.some(e=>e.type==='ack'),false);assert.equal(events.some(e=>e.type==='ready'),false);
  }
  const held=deferred();const {s,events}=start(t,{handshakeTimeoutMs:300,authority:{enrollBirth:()=>held.promise}});
  await s.done;held.resolve();assert.equal(events.some(e=>e.type==='ack'),false);
});
test('supervisor refuses missing authority, non-test activation and nonlocal application DB',()=>{
  assert.throws(()=>startSupervisor());
  const authority={localTestOnly:true,enrollBirth(){},openGate(){},beginDraining(){}};
  assert.throws(()=>startSupervisor({authority,environment:{NODE_ENV:'production'}}));
  assert.throws(()=>startSupervisor({authority,environment:{NODE_ENV:'test'},runtimeMode:'application-test',executorDatabaseUrl:'postgresql://synthetic@remote.invalid/db'}));
});

function manual(t,{heartbeatMs=30,heartbeatTimeoutMs=120}={}) {
  const child=fork(path.join(__dirname,'../executorBootstrap.js'),[],{env:{NODE_ENV:'test'},execArgv:[],stdio:['ignore','pipe','pipe','ipc']});
  let resolve;const done=new Promise(r=>{resolve=r;});child.on('exit',(code,signal)=>resolve({code,signal}));
  child.on('error',()=>{});child.stdout.resume();child.stderr.resume();
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill();}await done;});
  const init={protocol_version:VERSION,message_type:'INIT',supervisor_id:randomUUID(),supervisor_boot_id:randomUUID(),spawn_id:randomUUID(),
    executor_id:null,boot_id:null,sequence:1,challenge:randomBytes(32).toString('hex'),runtime_profile:PROFILE,revision:null,instance_id:null,
    session_key:randomBytes(32).toString('hex'),runtime_mode:'fixture',heartbeat_ms:heartbeatMs,heartbeat_timeout_ms:heartbeatTimeoutMs,handshake_timeout_ms:3000};
  const hello=new Promise(r=>child.once('message',r));child.on('spawn',()=>child.send(init));
  return {child,init,hello,done};
}
test('manual peer: stale ACK, wrong identity, nonce, profile, malformed and oversize all fail closed',async t=>{
  for(const kind of ['nonce','boot','supervisor','executor','profile','malformed','oversize','sequence','auth']) {
    const {child,init,hello,done}=manual(t);const m=await hello;const session={...m};for(const k of ['auth','protocol_version','message_type','sequence','pid','started_at'])delete session[k];
    const tx=channel(session,init.session_key,1);let ack=tx.message('ACK',{local_test_enrollment:true});
    if(kind==='nonce')ack={...ack,challenge:'a'.repeat(64)};
    if(kind==='boot')ack={...ack,boot_id:randomUUID()};if(kind==='supervisor')ack={...ack,supervisor_id:randomUUID()};
    if(kind==='executor')ack={...ack,executor_id:randomUUID()};if(kind==='profile')ack={...ack,runtime_profile:'bad'};
    if(kind==='malformed')ack={};if(kind==='oversize')ack={...ack,revision:'x'.repeat(5000)};
    if(kind==='sequence')ack={...ack,sequence:9};if(kind==='auth')ack={...ack,auth:'0'.repeat(64)};
    let started=false;child.on('message',v=>{if(v.message_type==='READY')started=true;});child.send(ack);
    const result=await done;assert.equal(started,false,kind);assert.equal(result.code,1,kind);
  }
});
test('manual peer: valid ACK followed by heartbeat expiry closes actual listener',async t=>{
  const {child,init,hello,done}=manual(t);const m=await hello;const session={...m};for(const k of ['auth','protocol_version','message_type','sequence','pid','started_at'])delete session[k];
  const ready=new Promise(r=>child.once('message',r));child.send(channel(session,init.session_key,1).message('ACK',{local_test_enrollment:true}));
  const event=await ready;assert.equal(event.message_type,'READY');assert.equal((await fetch('http://127.0.0.1:'+event.port)).status,200);
  await done;await assert.rejects(fetch('http://127.0.0.1:'+event.port));
});
test('manual peer: disconnect closes admission independently of process death',async t=>{
  const {child,hello,done}=manual(t);await hello;assert.equal(child.exitCode,null);child.disconnect();
  assert.equal(child.exitCode,null);await done;
});
test('profile guards deny business spawn, worker_threads, browsers and SDK before invocation, including ESM',async()=>{
  const source=`require('./services/supervision/profile').installSingleProcessProfile();
    const assert=require('node:assert/strict');
    for(const call of [()=>require('node:child_process').spawn('never'),()=>require('node:child_process').fork('never'),()=>new(require('node:worker_threads').Worker)('never'),()=>require('puppeteer'),()=>require('@wppconnect-team/wppconnect')])assert.throws(call,{code:'SUPERVISION_PROFILE_DENIED'});
    import('node:child_process').then(m=>{assert.throws(()=>m.spawn('never'),{code:'SUPERVISION_PROFILE_DENIED'});console.log('PROFILE_PASS');});`;
  const result=await new Promise((resolve,reject)=>execFile(process.execPath,['-e',source],{cwd:path.join(__dirname,'..'),env:{NODE_ENV:'test'},windowsHide:true},(error,stdout,stderr)=>error?reject(Error(stderr)):resolve(stdout)));
  assert.match(result,/PROFILE_PASS/);
});
