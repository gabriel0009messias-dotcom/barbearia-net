const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const path = require('node:path');
const { Pool } = require('pg');
const { randomUUID } = require('node:crypto');
const { startSupervisor } = require('../supervisor');
const root=path.join(__dirname,'..');
function isolated(source) {
  return new Promise((resolve,reject)=>execFile(process.execPath,['-e',source],{cwd:root,env:{NODE_ENV:'test'},windowsHide:true},(error,stdout,stderr)=>error?reject(Error(stderr)):resolve(stdout)));
}
test('pre-ACK boundary rejects real app/DB/timer imports and roots without reading .env',async()=>{
  const output=await isolated(`
    const assert=require('node:assert/strict'),fs=require('node:fs');
    const boundary=require('./services/supervision/context');
    const gate=boundary.install({identity:{executorId:'test',bootId:'test'},schemaAlreadyPrepared(){throw Error('must not run');},confirmEnrollment(){throw Error('must not run');}});
    const scope=require('./services/executionScope').executionScope;
    let reads=0,businessTimers=0;
    const read=fs.readFileSync,interval=global.setInterval;
    fs.readFileSync=function(file,...args){if(String(file).endsWith('.env')){reads++;throw Error('dotenv read');}return read.call(this,file,...args);};
    global.setInterval=(...args)=>{businessTimers++;return interval(...args);};
    require('./loadEnv').carregarEnv('/never/.env');
    for(const name of ['./app','./database/postgres','./evolutionConnectionGuard'])assert.throws(()=>require(name),{code:'INSTANCE_ADMISSION_CLOSED'});
    Promise.all([assert.rejects(scope.admit('business',()=>assert.fail())),assert.rejects(scope.admitRoot('business',()=>assert.fail())),assert.rejects(scope.follow('business',()=>assert.fail()))]).then(()=>{
      assert.equal(reads,0);assert.equal(businessTimers,0);assert.equal(require.cache[require.resolve('pg')],undefined);
      gate.close();assert.throws(gate.open);console.log('PRE_ACK_PASS');
    });`);
  assert.match(output,/PRE_ACK_PASS/);
});
test('loadEnv legacy mode retains file loading while supervised mode never touches it',async()=>{
  const output=await isolated(`
    const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'supervision-env-'));const file=path.join(dir,'.env');
    try{fs.writeFileSync(file,'STUDIOFY_SYNTHETIC_ENV=local-test-only');require('./loadEnv').carregarEnv(file);assert.equal(process.env.STUDIOFY_SYNTHETIC_ENV,'local-test-only');
      delete process.env.STUDIOFY_SYNTHETIC_ENV;require('./services/supervision/context').install({identity:{},schemaAlreadyPrepared(){},confirmEnrollment(){}});
      require('./loadEnv').carregarEnv(file);assert.equal(process.env.STUDIOFY_SYNTHETIC_ENV,undefined);console.log('ENV_PASS');
    }finally{fs.unlinkSync(file);fs.rmdirSync(dir);}`);
  assert.match(output,/ENV_PASS/);
});
test('shutdown during enrollment confirmation prevents later execution registration SQL',async()=>{
  const output=await isolated(`
    const assert=require('node:assert/strict');
    let release,entered;
    const held=new Promise(resolve=>{release=resolve;});
    const confirming=new Promise(resolve=>{entered=resolve;});
    const gate=require('./services/supervision/context').install({
      identity:{executorId:'synthetic',bootId:'synthetic'},schemaAlreadyPrepared(){},
      confirmEnrollment:async()=>{entered();await held;}
    });
    gate.open();
    let queries=0;
    const client={query:async()=>{queries++;return {rowCount:1};}};
    const pending=require('./services/executionLifecycle').registerExecution(client,'test_schema',{},'synthetic');
    const rejected=assert.rejects(pending,{code:'INSTANCE_ADMISSION_CLOSED'});
    confirming.then(async()=>{
      gate.close();release();await rejected;
      assert.equal(queries,0);console.log('ENROLLMENT_SHUTDOWN_PASS');
    }).catch(error=>{console.error(error);process.exitCode=1;});`);
  assert.match(output,/ENROLLMENT_SHUTDOWN_PASS/);
});

test('prepared schema boundary is read-only and rejects version/checksum mismatch',async()=>{
  const {verifyPreparedSchema}=require('../services/supervision/preparedSchema');const queries=[];
  await assert.rejects(verifyPreparedSchema({query:async sql=>{queries.push(sql);return {rows:[]};}}));
  assert.deepEqual(queries,['SELECT name,checksum FROM schema_migrations ORDER BY name']);
});
test('real app starts after ACK with a restricted executor, no migrations and no STOP proof', {timeout:90000},async t=>{
  const f=await require('./helpers/sql031PermissionFixture').permissionFixture(t);
  await f.validate('executor');
  const before=(await f.migrator.query('SELECT * FROM schema_migrations ORDER BY name')).rows;
  // Dedicated synthetic IDs in this fixture's disposable database, never historical deliveries.
  const ownerId=985601,messageId=985602,token=randomUUID();
  await f.migrator.query("INSERT INTO assinaturas(id,barbearia_nome,responsavel_nome,telefone,metodo_pagamento,dia_vencimento,suporte_numero,whatsapp_session,status,proximo_vencimento) VALUES($1,'Synthetic','Synthetic','11999990000','mercado_pago',5,'','supervision-synthetic','ativo','2099-01-01')",[ownerId]);
  await f.migrator.query('UPDATE evolution_instance_owners SET operation_token=$1,operation_started_at=clock_timestamp() WHERE owner_id=$2',[token,String(ownerId)]);
  await f.migrator.query("INSERT INTO whatsapp_messages(id,assinatura_id,instance,phone,message_id,response,status,attempts,sent_at,operation_token) VALUES($1,$2,'supervision-synthetic','5511999990000',$3,'Synthetic','uncertain',1,NULL,$4)",[messageId,ownerId,randomUUID(),token]);
  const syntheticState=async()=>({
    messages:(await f.migrator.query('SELECT to_jsonb(m) AS content,md5(to_jsonb(m)::text) AS fingerprint FROM whatsapp_messages m WHERE id=$1',[messageId])).rows,
    owners:(await f.migrator.query('SELECT to_jsonb(o) AS content,md5(to_jsonb(o)::text) AS fingerprint FROM evolution_instance_owners o WHERE owner_id=$1',[String(ownerId)])).rows,
  });
  const syntheticBefore=await syntheticState();
  assert.equal(syntheticBefore.messages.length,1);assert.equal(syntheticBefore.owners.length,1);
  const messageBefore=syntheticBefore.messages[0].content,ownerBefore=syntheticBefore.owners[0].content;
  assert.equal(messageBefore.id,messageId);assert.equal(messageBefore.assinatura_id,ownerId);
  assert.equal(messageBefore.status,'uncertain');assert.equal(messageBefore.attempts,1);assert.equal(messageBefore.sent_at,null);
  assert.equal(messageBefore.operation_token,token);assert.equal(messageBefore.response,'Synthetic');
  assert.equal(ownerBefore.owner_id,String(ownerId));assert.equal(ownerBefore.operation_token,token);
  for(const rows of Object.values(syntheticBefore))assert.match(rows[0].fingerprint,/^[a-f0-9]{32}$/);
  const enrollmentTables=['evolution_executors','evolution_supervisors','evolution_executor_birth_bindings','evolution_executor_gates'];
  const enrollmentState=async()=>Object.fromEntries(await Promise.all(enrollmentTables.map(async table=>[
    table,(await f.migrator.query('SELECT * FROM '+table+' ORDER BY '+(table==='evolution_supervisors'?'supervisor_id':'executor_id'))).rows,
  ])));
  const emptyEnrollment=Object.fromEntries(enrollmentTables.map(table=>[table,[]]));
  assert.deepEqual(await enrollmentState(),emptyEnrollment);await f.noStop();
  const events=[];let release;const held=new Promise(resolve=>{release=resolve;});
  const authority=f.supervisionAuthority({beforeBirth:()=>held});let draining;
  const s=startSupervisor({authority:{...authority,beginDraining(...args){draining=authority.beginDraining(...args);return draining;}},executorDatabaseUrl:f.urls.executor,runtimeMode:'application-test',
    environment:{NODE_ENV:'test',DATABASE_SCHEMA:f.schema,PORT:'0',RENDER:'true',PUBLIC_APP_URL:'https://example.test',
      DATABASE_URL:f.urls.migrator,ISSUER_DATABASE_URL:f.urls.issuer,MIGRATOR_DATABASE_URL:f.urls.migrator,CONTROL_SECRET:'synthetic-only'},
    heartbeatMs:200,heartbeatTimeoutMs:30000,handshakeTimeoutMs:60000,onEvent:e=>events.push(e)});
  let output='';s.child.stdout.on('data',d=>{output+=d;});s.child.stderr.on('data',d=>{output+=d;});
  t.after(async()=>{release();s.shutdown();await s.done;await draining;});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Missing HELLO')),5000);s.events.on('event',e=>{if(e.type==='hello'){clearTimeout(timer);resolve();}});});
  assert.equal(events.some(e=>e.type==='ready'),false);assert.doesNotMatch(output,/Servidor rodando|Migration aplicada/);
  assert.equal(s.snapshot().state,'ENROLLING');
  assert.equal(events.some(e=>['enrolled','before-ack','ack','shutdown','cooperative-acked'].includes(e.type)),false);
  assert.equal(s.snapshot().proof,false);assert.equal(s.snapshot().stopped,false);
  assert.deepEqual(await enrollmentState(),emptyEnrollment);await f.noStop();
  assert.deepEqual(await syntheticState(),syntheticBefore);
  assert.doesNotMatch(output,/PostgreSQL conectado|outbox_worker_started/);
  assert.equal(events.some(e=>['enrolled','before-ack','ack','ready'].includes(e.type)),false);
  const ready=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Runtime not ready: '+output)),60000);s.events.on('event',e=>{if(e.type==='ready'){clearTimeout(timer);resolve(e);}});});
  release();const event=await ready;const health=await fetch('http://127.0.0.1:'+event.port+'/health');assert.equal(health.status,200);assert.equal((await health.json()).ok,true);
  assert.deepEqual(events.filter(e=>['hello','enrolled','before-ack','ack','ready'].includes(e.type)).map(e=>[e.type,e.state]),[
    ['hello','ENROLLING'],['enrolled','ENROLLING'],['before-ack','ACK_SENT'],['ack','ACK_SENT'],['ready','RUNNING'],
  ]);
  const enrolled=await enrollmentState();
  for(const table of enrollmentTables)assert.equal(enrolled[table].length,1,table+' has exactly the authorized enrollment');
  const executor=enrolled.evolution_executors[0],supervisor=enrolled.evolution_supervisors[0];
  const birth=enrolled.evolution_executor_birth_bindings[0],gate=enrolled.evolution_executor_gates[0],session=s.snapshot();
  assert.equal(supervisor.supervisor_id,session.supervisor_id);assert.equal(supervisor.supervisor_boot_id,session.supervisor_boot_id);
  assert.equal(supervisor.process_id,process.pid);assert.equal(supervisor.issuer_role,f.roles.issuer);
  assert.equal(birth.supervisor_id,supervisor.supervisor_id);assert.equal(birth.supervisor_boot_id,supervisor.supervisor_boot_id);
  assert.equal(birth.spawn_id,session.spawn_id);assert.equal(birth.observed_pid,s.child.pid);
  assert.equal(executor.executor_id,birth.executor_id);assert.equal(executor.boot_id,birth.boot_id);assert.equal(executor.process_id,s.child.pid);
  assert.equal(gate.executor_id,birth.executor_id);assert.equal(gate.boot_id,birth.boot_id);assert.equal(gate.state,'OPEN');
  assert.deepEqual(await syntheticState(),syntheticBefore);await f.noStop();
  s.shutdown();const closure=await s.done;assert.equal(closure.cooperativeClosed,true);assert.equal(closure.proof,false);assert.equal(closure.stopped,false);
  // Observe completion of the existing authority call; do not poll or change supervisor shutdown.
  assert.ok(draining instanceof Promise);await draining;
  assert.deepEqual(await syntheticState(),syntheticBefore);
  const finalEnrollment=await enrollmentState();
  for(const table of enrollmentTables.filter(table=>table!=='evolution_executor_gates'))assert.deepEqual(finalEnrollment[table],enrolled[table]);
  assert.equal(finalEnrollment.evolution_executor_gates.length,1);
  const drainedGate=finalEnrollment.evolution_executor_gates[0];
  assert.equal(drainedGate.state,'DRAINING');assert.ok(drainedGate.updated_at instanceof Date);
  assert.ok(drainedGate.updated_at.getTime()>=gate.updated_at.getTime());
  assert.deepEqual(drainedGate,{...gate,state:'DRAINING',updated_at:drainedGate.updated_at});
  assert.deepEqual((await f.migrator.query('SELECT * FROM schema_migrations ORDER BY name')).rows,before);
  await f.noStop();
  assert.doesNotMatch(output,/Migration aplicada|Falha ao inicializar|erro ao|Falha ao processar/);
});
