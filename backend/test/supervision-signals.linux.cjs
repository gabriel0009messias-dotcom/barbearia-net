// MANDATORY separate Linux gate: node --test test/supervision-signals.linux.cjs
// Deliberately not a *.test.js file: Windows cannot approve this requirement.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, fork } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { startSupervisor } = require('../supervisor');
const root = path.join(__dirname,'..'), helper = path.join(__dirname,'helpers/supervisedParent.js');
assert.equal(process.platform,'linux','Mandatory Linux gate must execute on Linux');
assert.equal(process.version,'v20.20.1','Mandatory Linux gate must execute on Node 20.20.1');
const wait = ms => new Promise(resolve=>setTimeout(resolve,ms));
function parent(t,args=[],command=process.execPath,options={}) {
  const child=spawn(command,command===process.execPath?[helper,...args]:args,{cwd:root,env:{NODE_ENV:'test',PATH:process.env.PATH,HOME:os.tmpdir()},stdio:['ignore','pipe','pipe'],...options});
  let output='';const listeners=[];child.stdout.on('data',d=>{output+=d;for(const fn of listeners)fn();});child.stderr.on('data',d=>{output+=d;});
  const done=new Promise((resolve,reject)=>{child.once('exit',(code,signal)=>resolve({code,signal}));child.once('error',reject);});
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await done;});
  const event=type=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Missing '+type+': '+output)),10000);const check=()=>{const line=output.split('\n').find(l=>l.startsWith('PARENT ')&&JSON.parse(l.slice(7)).type===type);if(line){clearTimeout(timer);resolve(JSON.parse(line.slice(7)));}};listeners.push(check);check();});
  return {child,done,event,output:()=>output};
}
test('real Linux SIGTERM during enrollment closes ACK permanently and forwards to real child',async t=>{
  const p=parent(t,['2000']);await p.event('hello');p.child.kill('SIGTERM');
  await p.done;assert.match(p.output(),/signal-forwarded/);assert.doesNotMatch(p.output(),/"type":"ack"|"type":"ready"/);
  assert.match(p.output(),/"proof":false/);
});
test('real Linux SIGTERM after ACK drains actual listener; kill request is not exit',async t=>{
  const p=parent(t);const ready=await p.event('ready');assert.equal((await fetch('http://127.0.0.1:'+ready.port)).status,200);
  p.child.kill('SIGTERM');await p.done;assert.match(p.output(),/"type":"exit"/);assert.match(p.output(),/"type":"close"/);
  await assert.rejects(fetch('http://127.0.0.1:'+ready.port));
});
test('real Linux kill request and child.killed never become a proof before actual exit',async t=>{
  const s=startSupervisor({authority:{localTestOnly:true,enrollBirth:async()=>{},openGate:async()=>{},beginDraining:async()=>{}},environment:{NODE_ENV:'test'}});
  s.child.stdout.resume();s.child.stderr.resume();t.after(async()=>{s.shutdown();await s.done;});
  await new Promise(resolve=>s.events.on('event',e=>{if(e.type==='ready')resolve();}));
  s.child.kill('SIGKILL');assert.equal(s.child.killed,true);assert.equal(s.snapshot().exit,null);assert.equal(s.snapshot().proof,false);
  const result=await s.done;assert.equal(result.exit.signal,'SIGKILL');assert.equal(result.proof,false);
});
test('supervisor SIGKILL disconnects child, which withdraws authority without proof',async t=>{
  const p=parent(t);const ready=await p.event('ready');p.child.kill('SIGKILL');await p.done;
  for(let i=0;i<50;i++){try{await fetch('http://127.0.0.1:'+ready.port);}catch{return;}await wait(50);}
  assert.fail('Executor listener survived supervisor disconnect.');
});
test('future npm/shell chain must forward real SIGTERM; current package start is preserved',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'supervision-npm-'));
  t.after(()=>{fs.unlinkSync(path.join(dir,'package.json'));fs.rmdirSync(dir);});
  const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
  fs.writeFileSync(path.join(dir,'package.json'),JSON.stringify({scripts:{start:'exec '+quote(process.execPath)+' '+quote(helper)}}));
  const p=parent(t,['start','--silent'],'npm',{cwd:dir});const ready=await p.event('ready');
  const supervisor=await p.event('starting');
  t.after(()=>{try{process.kill(supervisor.pid,'SIGKILL');}catch{}});
  p.child.kill('SIGTERM');await p.done;
  // A failed forwarding result blocks this Linux gate instead of being hidden.
  for(let i=0;i<40;i++){try{await fetch('http://127.0.0.1:'+ready.port);}catch{break;}if(i===39)assert.fail('npm did not forward shutdown; require a direct exec entrypoint.');await wait(50);}
  await assert.rejects(fetch('http://127.0.0.1:'+ready.port));
  assert.equal(JSON.parse(fs.readFileSync(path.join(root,'package.json'))).scripts.start,'node app.js');
});
