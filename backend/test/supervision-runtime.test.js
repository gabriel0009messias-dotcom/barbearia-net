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
test('real app starts after ACK on prepared local PostgreSQL without migrations, registration or proof writes', {timeout:30000},async t=>{
  const env=require('./helpers/postgres').testEnvironment();
  const pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:'-c search_path='+env.schema+',public'});
  t.after(async()=>{await pool.end();await env.cleanup();});
  await require('../database/migrate').migrate(pool,env.schema);
  const token=randomUUID();
  await pool.query("INSERT INTO assinaturas(id,barbearia_nome,responsavel_nome,telefone,metodo_pagamento,dia_vencimento,suporte_numero,whatsapp_session,status,proximo_vencimento) VALUES(95003,'Synthetic','Synthetic','11999990000','mercado_pago',5,'','supervision-synthetic','ativo','2099-01-01')");
  await pool.query("UPDATE evolution_instance_owners SET operation_token=$1,operation_started_at=clock_timestamp() WHERE owner_id='95003'",[token]);
  await pool.query("INSERT INTO whatsapp_messages(id,assinatura_id,instance,phone,message_id,response,status,attempts,sent_at,operation_token) VALUES(37,95003,'supervision-synthetic','5511999990000','synthetic-supervision-37','Synthetic','uncertain',1,NULL,$1)",[token]);
  const protectedState=async()=>({row:(await pool.query('SELECT md5(to_jsonb(m)::text) fingerprint FROM whatsapp_messages m WHERE id=37')).rows[0],owner:(await pool.query("SELECT md5(to_jsonb(o)::text) fingerprint FROM evolution_instance_owners o WHERE owner_id='95003'")).rows[0]});
  const before=await protectedState();const migrations=(await pool.query('SELECT * FROM schema_migrations ORDER BY name')).rows;
  const events=[];let release;const held=new Promise(resolve=>{release=resolve;});
  const authority={localTestOnly:true,enrollBirth:async()=>held,openGate:async()=>{},beginDraining:async()=>{}};
  const s=startSupervisor({authority,executorDatabaseUrl:process.env.TEST_DATABASE_URL,runtimeMode:'application-test',
    environment:{NODE_ENV:'test',DATABASE_SCHEMA:env.schema,PORT:'0',RENDER:'true',PUBLIC_APP_URL:'https://example.test'},
    heartbeatMs:100,heartbeatTimeoutMs:3000,handshakeTimeoutMs:15000,onEvent:e=>events.push(e)});
  let output='';s.child.stdout.on('data',d=>{output+=d;});s.child.stderr.on('data',d=>{output+=d;});
  t.after(async()=>{release();s.shutdown();await s.done;});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Missing HELLO: '+output)),5000);s.events.on('event',e=>{if(e.type==='hello'){clearTimeout(timer);resolve();}});});
  assert.equal(events.some(e=>e.type==='ready'),false);assert.doesNotMatch(output,/Servidor rodando|PostgreSQL conectado|outbox_worker_started/);
  const ready=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Runtime not ready: '+output)),15000);s.events.on('event',e=>{if(e.type==='ready'){clearTimeout(timer);resolve(e);}});});
  release();const event=await ready;const health=await fetch('http://127.0.0.1:'+event.port+'/health');assert.equal(health.status,200);assert.equal((await health.json()).ok,true);
  s.shutdown();const closure=await s.done;assert.equal(closure.cooperativeClosed,true);
  assert.deepEqual(await protectedState(),before);assert.deepEqual((await pool.query('SELECT * FROM schema_migrations ORDER BY name')).rows,migrations);
  for(const table of ['evolution_executors','evolution_supervisors','evolution_executor_birth_bindings','evolution_executor_gates','evolution_executor_closure_events','evolution_execution_stop_proofs','evolution_execution_stops'])assert.equal((await pool.query('SELECT count(*)::int n FROM '+table)).rows[0].n,0,table);
  assert.doesNotMatch(output,/Migration aplicada|Falha ao inicializar|erro ao|Falha ao processar/);
});
