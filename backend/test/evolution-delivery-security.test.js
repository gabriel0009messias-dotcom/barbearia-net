const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { createEvolutionDelivery } = require('../services/evolutionDelivery');
const { createEvolutionOwnershipOperation } = require('../services/evolutionOwnershipOperation');
const accepted = () => ({key:{id:randomUUID()},status:'PENDING'});

test('OWN-01/02/03: durable PostgreSQL dispatch, isolation and uncertain outcomes', {timeout:120000}, async t => {
 const env=require('./helpers/postgres').testEnvironment(),db=require('../database');await db.ready;
 await require('./helpers/appointmentTransportPolicy').enableAppointmentTransport(db);
 const api=require('../evolutionApi'),webhook=require('../evolutionWebhook');
 const {createReminderWorker}=require('./helpers/reminderClock');
 const delivery=createEvolutionDelivery(db),op=createEvolutionOwnershipOperation(db.pool);
 const q=(sql,args=[])=>db.pool.query(sql,args);
 const assign=(id,name)=>q('UPDATE assinaturas SET whatsapp_session=$2 WHERE id=$1',[id,name]);
 const message=async()=>{const r=await db.getAsync("INSERT INTO whatsapp_messages(assinatura_id,instance,phone,message_id,response) VALUES(806,'own-test-a','5511999990000',$1,'Synthetic only') RETURNING *",[randomUUID()]);return r;};
 const state=async(table='whatsapp_messages')=>db.getAsync('SELECT * FROM '+table+' ORDER BY id LIMIT 1');
 const fence=async()=>db.getAsync("SELECT * FROM evolution_instance_owners WHERE owner_id='806'");
 const clock=()=>new Date('2030-01-02T12:45:00Z');
 const reminder=()=>db.runAsync("INSERT INTO agendamentos(assinatura_id,nome_cliente,telefone,servico_nome,preco,data,hora,status) VALUES(806,'Synthetic Customer','5511999990000','Synthetic Service',30,'2030-01-02','10:00','confirmado')");
 const reset=async()=>{
  await q('UPDATE evolution_instance_owners SET operation_token=NULL,operation_started_at=NULL');
  await q('DELETE FROM whatsapp_conversations');await q('DELETE FROM whatsapp_conversation_inbox');
  await q('DELETE FROM whatsapp_messages');await q('DELETE FROM agendamentos');
  await assign(806,null);await assign(807,null);await assign(806,'own-test-a');await assign(807,'own-test-b');
 };
 for(const id of [806,807])await db.runAsync("INSERT INTO assinaturas(id,barbearia_nome,responsavel_nome,telefone,metodo_pagamento,dia_vencimento,suporte_numero,status,proximo_vencimento) VALUES($1,'Synthetic Studio','Owner','11999990000','mercado_pago',5,'','ativo','2099-01-01')",[id]);
 t.beforeEach(reset);t.after(async()=>{await reset();await db.close();await env.cleanup()});
 for(const level of ['info','error'])t.mock.method(console,level,()=>{});
 await t.test('OWN-01: matching persisted tenant and instance may send; acceptance is persisted',async()=>{
  await message();let calls=0;await webhook.drain(async instance=>{calls++;assert.equal(instance,'own-test-a');assert.ok((await fence()).operation_token);assert.equal((await q("SELECT count(*)::int n FROM pg_stat_activity WHERE state='idle in transaction' AND query LIKE $1",['%'+env.schema+'%'])).rows[0].n,0);return accepted()});
  assert.equal(calls,1);assert.equal((await state()).status,'sent');assert.equal((await fence()).operation_token,null);
 });
 await t.test('OWN-01: old queued instance reassigned to another owner is rejected',async()=>{
  await message();await assign(806,null);await assign(807,'own-test-a');let calls=0;await webhook.drain(async()=>{calls++});assert.equal(calls,0);assert.equal((await state()).status,'failed');
 });
 await t.test('OWN-01: association changed after claim is not silently replaced',async()=>{
  const row=await message();await q("UPDATE whatsapp_messages SET status='sending',claim_token=$1 WHERE id=$2",[randomUUID(),row.id]);
  const claimed=await state();await assign(806,'own-test-new');let calls=0;await delivery.dispatch('whatsapp_messages',claimed,async()=>{calls++});assert.equal(calls,0);assert.equal((await state()).status,'failed');
 });
 await t.test('OWN-01: absent persisted association never dispatches',async()=>{await message();await assign(806,null);await webhook.drain(()=>assert.fail());assert.equal((await state()).status,'failed')});
 await t.test('OWN-01: ambiguous resolver result fails closed',async sub=>{
  const row=await message();await q("UPDATE whatsapp_messages SET status='sending',claim_token=$1 WHERE id=$2",[randomUUID(),row.id]);
  const ambiguousPool={connect:async()=>{
   const c=await db.pool.connect();return {on:(...a)=>c.on(...a),removeListener:(...a)=>c.removeListener(...a),release:(...a)=>c.release(...a),query:async config=>{
    const result=await c.query(config);if(config.text.includes('SELECT model,source_schema,owner_id,instance_name'))return {...result,rows:[result.rows[0],result.rows[0]]};return result;
   }};
  }};
  await createEvolutionDelivery({...db,pool:ambiguousPool}).dispatch('whatsapp_messages',await state(),()=>assert.fail());assert.equal((await state()).status,'failed');
 });
 await t.test('persisted delivery identity cannot be replaced by an arbitrary tenant',async()=>{
  const row=await message(),claim=randomUUID();await q("UPDATE whatsapp_messages SET status='sending',claim_token=$1",[claim]);
  await delivery.dispatch('whatsapp_messages',{...row,claim_token:claim,assinatura_id:807,instance:'own-test-b'},()=>assert.fail());assert.equal((await state()).status,'failed');
 });
 await t.test('lost reservation commit acknowledgement before transport safely revokes the persisted reservation',async()=>{
  const row=await message(),claim=randomUUID();await q("UPDATE whatsapp_messages SET status='sending',claim_token=$1",[claim]);
  const wrapped={connect:async()=>{const c=await db.pool.connect();return {on:(...a)=>c.on(...a),removeListener:(...a)=>c.removeListener(...a),release:(...a)=>c.release(...a),query:async config=>{const result=await c.query(config);if(config.text==='COMMIT')throw Error('Synthetic lost acknowledgement');return result}}}};
  await createEvolutionDelivery({...db,pool:wrapped}).dispatch('whatsapp_messages',{...row,claim_token:claim},()=>assert.fail());
  const stored=await state();assert.equal(stored.status,'pending');assert.equal(stored.operation_token,null);assert.equal((await fence()).operation_token,null);assert.equal(stored.dispatch_started_at,null);assert.notEqual(stored.claim_token,claim);
 });
 await t.test('OWN-01: two workers claim the message once',async()=>{await message();let calls=0;const send=async()=>{calls++;await new Promise(r=>setTimeout(r,30));return accepted()};await Promise.all([webhook.drain(send),webhook.drain(send)]);assert.equal(calls,1)});
 await t.test('OWN-01: durable reservation blocks legacy queue without sending',async()=>{await message();await op.run(806,async()=>{await webhook.drain(()=>assert.fail());assert.equal((await state()).status,'pending')})});
 await t.test('OWN-02: valid reminder uses reserved current owner',async()=>{await reminder();let calls=0;await createReminderWorker(db,async instance=>{calls++;assert.equal(instance,'own-test-a');assert.ok((await fence()).operation_token);return accepted()},clock).drain();assert.equal(calls,1);assert.equal((await state('appointment_reminders')).status,'sent')});
 await t.test('OWN-02: concurrent reassignment is blocked throughout transport',async()=>{await reminder();await createReminderWorker(db,async()=>{await assert.rejects(assign(806,null),e=>e.code==='23514');return accepted()},clock).drain();assert.equal((await state('appointment_reminders')).status,'sent')});
 await t.test('OWN-02: reminder snapshot whose instance now belongs to B is rejected',async()=>{
  await reminder();const row=await state('appointment_reminders');const claim=randomUUID();await q("UPDATE appointment_reminders SET status='sending',claim_token=$1 WHERE id=$2",[claim,row.id]);
  await assign(806,null);await assign(807,'own-test-a');await delivery.dispatch('appointment_reminders',{...row,claim_token:claim,instance:'own-test-a'},()=>assert.fail());assert.equal((await state('appointment_reminders')).status,'failed');
 });
 await t.test('OWN-02: incompatible reservation prevents reminder transport',async()=>{await reminder();await op.run(806,async()=>{await createReminderWorker(db,()=>assert.fail(),clock).drain();assert.equal((await state('appointment_reminders')).status,'pending')})});
 await t.test('OWN-02: two reminder workers cannot duplicate',async()=>{await reminder();let calls=0;const send=async()=>{calls++;return accepted()};await require('./helpers/reminderClock').setReminderClock(db,clock());await Promise.all([createReminderWorker(db,send).drain(),createReminderWorker(db,send).drain()]);assert.equal(calls,1)});
 await t.test('OWN-02: appointment cancellation is rechecked before transport',async()=>{await reminder();const row=await state('appointment_reminders');const claim=randomUUID();await q("UPDATE appointment_reminders SET status='sending',claim_token=$1 WHERE id=$2",[claim,row.id]);await q("UPDATE agendamentos SET status='cancelado' WHERE id=$1",[row.appointment_id]);await delivery.dispatch('appointment_reminders',{...row,claim_token:claim,instance:'own-test-a'},()=>assert.fail(),{validate:async()=>false});assert.equal((await state('appointment_reminders')).status,'failed')});
 for(const [label,failure,status] of [
  ['known rejection',{deliveryOutcome:'rejected'},'failed'],
  ['safe local failure',{deliveryOutcome:'not_attempted'},'pending'],
  ['timeout after possible transmission',{code:'EVOLUTION_TIMEOUT'},'uncertain'],
  ['interrupted connection',{code:'EVOLUTION_OFFLINE'},'uncertain'],
 ])await t.test('OWN-03: '+label,async()=>{await message();await webhook.drain(async()=>{throw Object.assign(Error('Synthetic'),failure)});assert.equal((await state()).status,status);assert.equal(Boolean((await fence()).operation_token),status==='uncertain')});
 await t.test('OWN-03: missing acceptance evidence is uncertain',async()=>{await message();await webhook.drain(async()=>({ok:true}));assert.equal((await state()).status,'uncertain')});
 await t.test('OWN-03: restart and second worker never replay uncertain delivery',async()=>{await message();let calls=0;await webhook.drain(async()=>{calls++;throw Error('Unknown')});await webhook.drain(()=>assert.fail());await createEvolutionDelivery(db).dispatch('whatsapp_messages',await state(),()=>assert.fail());assert.equal(calls,1);assert.equal((await state()).status,'uncertain')});
 await t.test('OWN-03: uncertainty cannot be reset through ordinary updates',async()=>{await message();await webhook.drain(async()=>{throw Error('Unknown')});await assert.rejects(q("UPDATE whatsapp_messages SET status='pending'"),e=>e.code==='23514')});
 await t.test('OWN-03: explicit reconciliation checks owner and token, then atomically releases',async()=>{await message();await webhook.drain(async()=>{throw Error('Unknown')});const row=await state();await assert.rejects(delivery.reconcile('whatsapp_messages',row.id,807,row.operation_token,{stopped:true,outcome:'not_accepted'}));await assert.rejects(delivery.reconcile('whatsapp_messages',row.id,806,randomUUID(),{stopped:true,outcome:'not_accepted'}));await assert.rejects(delivery.reconcile('whatsapp_messages',row.id,806,row.operation_token,{outcome:'not_accepted'}));await delivery.reconcile('whatsapp_messages',row.id,806,row.operation_token,{stopped:true,outcome:'not_accepted'});assert.equal((await state()).status,'pending');assert.equal((await fence()).operation_token,null);await webhook.drain(accepted);assert.equal((await state()).status,'sent')});
 await t.test('OWN-03: imported legacy attempt is quarantined before any new dispatch',async()=>{
  await message();await q('UPDATE whatsapp_messages SET attempts=1');await webhook.drain(()=>assert.fail());assert.equal((await state()).status,'uncertain');
 });
 await t.test('OWN-03: crashed claim after durable transport intent becomes uncertain, never pending',async()=>{await message();await q("UPDATE whatsapp_messages SET status='sending',claim_token=$1,dispatch_started_at=CURRENT_TIMESTAMP,claimed_at=CURRENT_TIMESTAMP-interval '3 minutes'",[randomUUID()]);await webhook.drain(()=>assert.fail());assert.equal((await state()).status,'uncertain')});
 await t.test('OWN-03: local operation timeout fences late callback and requires reconciliation',async()=>{const row=await message(),claim=randomUUID();await q("UPDATE whatsapp_messages SET status='sending',claim_token=$1",[claim]);let finish;const late=new Promise(r=>{finish=r});await createEvolutionDelivery(db,{timeoutMs:20}).dispatch('whatsapp_messages',{...row,claim_token:claim},()=>late);assert.equal((await state()).status,'uncertain');finish(accepted());await new Promise(r=>setTimeout(r,20));assert.equal((await state()).status,'uncertain');assert.ok((await fence()).operation_token)});
 await t.test('OWN-03: uncertain reminder survives restart, rescheduling and cancellation',async()=>{await reminder();await createReminderWorker(db,async()=>{throw Error('Unknown')},clock).drain();await q("UPDATE agendamentos SET hora='11:00'");await q("UPDATE agendamentos SET status='cancelado'");await createReminderWorker(db,()=>assert.fail(),clock).drain();assert.equal((await state('appointment_reminders')).status,'uncertain')});
 await t.test('transport: direct text/list and generic message request require ownership',async()=>{await assert.rejects(api.enviarTextoInstancia('own-test-a','5511999990000','Synthetic'),{code:'INSTANCE_OPERATION_REQUIRED'});await assert.rejects(api.enviarListaInstancia('own-test-a','5511999990000'),{code:'INSTANCE_OPERATION_REQUIRED'});await assert.rejects(api.evolutionRequest('/message/sendText/own-test-a',{method:'POST'}),{code:'INSTANCE_OPERATION_REQUIRED'})});
 for(const status of [200,400,401,403,408,429,500,502,503,504])await t.test('transport: HTTP '+status+' classified without real provider',async sub=>{
  process.env.EVOLUTION_API_URL='https://own-transport.test';process.env.EVOLUTION_API_KEY='synthetic';
  require('../evolutionConnectionGuard').clearRateLimit('https://own-transport.test|own-test-a');
  sub.mock.method(global,'fetch',async()=>Response.json(status===200?accepted():{error:true},{status}));
  await message();await webhook.drain();assert.equal((await state()).status,status===200?'sent':status<500&&status!==408?'failed':'uncertain');
 });
 await t.test('real process restart retains uncertain claim and reservation',async()=>{
  await message();const code="const db=require('./database');db.ready.then(()=>require('./evolutionWebhook').drain(async()=>{process.send('attempted');await new Promise(()=>{})}));";
  const child=spawn(process.execPath,['-e',code],{cwd:path.join(__dirname,'..'),env:process.env,windowsHide:true,stdio:['ignore','ignore','ignore','ipc']});
  const exited=new Promise(r=>child.once('exit',r));
  try {await new Promise((resolve,reject)=>{child.once('message',resolve);child.once('error',reject)});assert.ok((await state()).operation_token);child.kill();await exited;
   await q("UPDATE whatsapp_messages SET claimed_at=CURRENT_TIMESTAMP-interval '3 minutes'");await webhook.drain(()=>assert.fail());
   const row=await state();assert.equal(row.status,'uncertain');assert.equal(row.operation_token,(await fence()).operation_token);
   await delivery.reconcile('whatsapp_messages',row.id,806,row.operation_token,{stopped:true,outcome:'rejected'});assert.equal((await state()).status,'failed');
  } finally { if(child.exitCode===null)child.kill(); }
 });
 await t.test('duplicate logical webhook events have one durable row and one acceptance',async()=>{
  process.env.EVOLUTION_WEBHOOK_SECRET='synthetic';process.env.PUBLIC_APP_URL='https://example.test';let calls=0;
  const payload={event:'messages.upsert',instance:'own-test-a',data:{key:{remoteJid:'5511999990000@s.whatsapp.net',fromMe:false,id:'logical-event'},message:{conversation:'oi'}}};
  const send=async()=>{calls++;return accepted()};
  await Promise.all([webhook.processarWebhookEvolution(payload,{'x-webhook-secret':'synthetic'},{send}),webhook.processarWebhookEvolution(payload,{'x-webhook-secret':'synthetic'},{send})]);
  await webhook.processarWebhookEvolution(payload,{'x-webhook-secret':'synthetic'},{send});
  assert.equal(calls,1);assert.equal((await db.getAsync('SELECT count(*)::int n FROM whatsapp_messages')).n,1);
 });
 await t.test('multi-process ingestion: the same provider event produces one confirmation',async()=>{
  const code="process.env.EVOLUTION_WEBHOOK_SECRET='synthetic';process.env.PUBLIC_APP_URL='https://example.test';const db=require('./database');const payload={event:'messages.upsert',instance:'own-test-a',data:{key:{remoteJid:'5511999990000@s.whatsapp.net',fromMe:false,id:'same-event-two-processes'},message:{conversation:'oi'}}};db.ready.then(()=>require('./evolutionWebhook').processarWebhookEvolution(payload,{'x-webhook-secret':'synthetic'},{send:async()=>{process.send('sent');return {key:{id:'synthetic'},status:'PENDING'}}})).then(()=>db.close()).catch(()=>process.exitCode=1);";
  let calls=0;const run=()=>new Promise((resolve,reject)=>{const c=spawn(process.execPath,['-e',code],{cwd:path.join(__dirname,'..'),env:process.env,windowsHide:true,stdio:['ignore','ignore','ignore','ipc']});c.on('message',()=>calls++);c.on('error',reject);c.on('exit',exit=>exit===0?resolve():reject(Error('Child '+exit)))});
  await Promise.all([run(),run()]);assert.equal(calls,1);assert.equal((await db.getAsync('SELECT count(*)::int n FROM whatsapp_messages')).n,1);assert.equal((await state()).status,'sent');
 });
 await t.test('multi-process: two Render equivalents share a PostgreSQL claim',async()=>{
  await message();const code="const db=require('./database');const w=require('./evolutionWebhook');db.ready.then(()=>w.drain(async()=>{process.send('sent');await new Promise(r=>setTimeout(r,50));return {key:{id:'synthetic'},status:'PENDING'}})).then(()=>db.close()).catch(()=>process.exitCode=1);";
  let calls=0;const run=()=>new Promise((resolve,reject)=>{const c=spawn(process.execPath,['-e',code],{cwd:path.join(__dirname,'..'),env:process.env,windowsHide:true,stdio:['ignore','ignore','ignore','ipc']});c.on('message',()=>calls++);c.on('error',reject);c.on('exit',exit=>exit===0?resolve():reject(Error('Child '+exit)))});
  await Promise.all([run(),run()]);assert.equal(calls,1);assert.equal((await state()).status,'sent');
 });
});

test('019 delivery migration: valid legacy upgrade, quarantine, rollback and runner idempotence',async t=>{
 const fs=require('node:fs'),{Pool}=require('pg');const env=require('./helpers/postgres').testEnvironment();
 const pool=new Pool(require('../database/config').connectionConfig());
 t.after(async()=>{await pool.end();await env.cleanup()});
 const c=await pool.connect();
 try {
  await c.query('BEGIN');await c.query('CREATE SCHEMA "'+env.schema+'"');await c.query('SET LOCAL search_path TO "'+env.schema+'",public');
  await c.query("SELECT set_config('studiofy.evolution_legacy_schema','public',true)");
  const directory=path.join(__dirname,'../database/migrations');
  for(const name of fs.readdirSync(directory).sort().filter(n=>n.endsWith('.sql')&&n<'019'))await c.query(fs.readFileSync(path.join(directory,name),'utf8'));
  await c.query("INSERT INTO assinaturas(id,barbearia_nome,responsavel_nome,telefone,metodo_pagamento,dia_vencimento,suporte_numero) VALUES(806,'Synthetic','Owner','11999990000','mercado_pago',5,'')");
  for(const [id,status,attempts] of [['fresh','pending',0],['ambiguous','pending',1],['accepted','sent',1]])await c.query("INSERT INTO whatsapp_messages(assinatura_id,instance,phone,message_id,response,status,attempts) VALUES(806,'migration-test','5511999990000',$1,'Synthetic',$2,$3)",[id,status,attempts]);
  await c.query('COMMIT');
  const before=(await c.query('SELECT * FROM whatsapp_messages ORDER BY id')).rows;
  const migration=fs.readFileSync(path.join(directory,'019_evolution_delivery_states.sql'),'utf8');
  await c.query('BEGIN');await c.query(migration);await c.query('ROLLBACK');
  assert.deepEqual((await c.query('SELECT * FROM whatsapp_messages ORDER BY id')).rows,before);
  assert.equal((await c.query("SELECT count(*)::int n FROM information_schema.columns WHERE table_schema=$1 AND table_name='whatsapp_messages' AND column_name='claim_token'",[env.schema])).rows[0].n,0);
  await c.query("INSERT INTO whatsapp_messages(assinatura_id,instance,phone,message_id,response,status) VALUES(806,'migration-test','5511999990000','invalid-legacy','Synthetic','invalid')");
  const conflicting=(await c.query('SELECT * FROM whatsapp_messages ORDER BY id')).rows;
  await c.query('BEGIN');await assert.rejects(c.query(migration),e=>e.code==='23514');await c.query('ROLLBACK');
  assert.deepEqual((await c.query('SELECT * FROM whatsapp_messages ORDER BY id')).rows,conflicting);
  await c.query("DELETE FROM whatsapp_messages WHERE message_id='invalid-legacy'");
  await c.query('BEGIN');await c.query(migration);await c.query('COMMIT');
  const after=(await c.query('SELECT * FROM whatsapp_messages ORDER BY id')).rows;
  assert.deepEqual(after.map(x=>x.status),['pending','uncertain','sent']);
  for(let i=0;i<before.length;i++)for(const field of ['id','assinatura_id','instance','phone','message_id','response','attempts','sent_at'])assert.deepEqual(after[i][field],before[i][field]);
  await assert.rejects(c.query("UPDATE whatsapp_messages SET status='pending' WHERE message_id='ambiguous'"),e=>e.code==='23514');
 } finally {c.release()}
});
