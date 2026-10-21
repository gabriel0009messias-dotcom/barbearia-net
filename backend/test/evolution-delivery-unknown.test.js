const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { fixture } = require('./helpers/conversation');
const { createEvolutionDelivery } = require('../services/evolutionDelivery');

test('unknown delivery disposition is terminal, audited and never a retry authorization', { timeout: 120000 }, async t => {
  const env = require('./helpers/postgres').testEnvironment();
  process.env.EVOLUTION_WEBHOOK_SECRET = 'conversation-test-secret';
  const db = require('../database'); await db.ready;
  t.after(async () => { await db.close(); await env.cleanup(); });
  const delivery = createEvolutionDelivery(db), phone = '551188887777';
  const state = id => db.getAsync('SELECT * FROM whatsapp_messages WHERE id=$1',[id]);
  const owner = f => db.getAsync('SELECT * FROM evolution_instance_owners WHERE owner_id=$1',[String(f.tenant)]);
  const receipt = id => db.getAsync("SELECT * FROM evolution_delivery_reconciliations WHERE delivery_kind='whatsapp_messages' AND delivery_id=$1",[id]);
  async function pending() {
    const f = await fixture(db,{known:false});
    await f.webhook.processarWebhookEvolution(f.payload('oi',{phone}),f.headers,{deferDelivery:true});
    return { f, row: await db.getAsync('SELECT * FROM whatsapp_messages WHERE assinatura_id=$1',[f.tenant]) };
  }
  async function incident() {
    const { f, row } = await pending(); let calls = 0;
    await f.webhook.drain(async () => { calls++; throw Error('Synthetic ambiguous failure after provider call'); });
    assert.equal(calls,1);
    const uncertain = await state(row.id);
    assert.equal(uncertain.status,'uncertain'); assert.equal(uncertain.attempts,1);
    assert.equal((await owner(f)).operation_token,uncertain.operation_token);
    return {f,row:uncertain};
  }
  const abandon = (f,row,extra={}) => delivery.reconcile('whatsapp_messages',row.id,f.tenant,row.operation_token,{stopped:true,outcome:'abandoned_unknown',expectedInstance:f.instance,...extra});
  const childReconcile = (f,row,outcome='abandoned_unknown') => new Promise(resolve => {
    const code = `const db=require('./database');db.ready.then(()=>require('./services/evolutionDelivery').createEvolutionDelivery(db).reconcile('whatsapp_messages',${row.id},${f.tenant},'${row.operation_token}',${JSON.stringify({stopped:true,outcome,expectedInstance:f.instance})})).then(()=>db.close()).catch(async()=>{await db.close();process.exitCode=1});`;
    const child = spawn(process.execPath,['-e',code],{cwd:path.join(__dirname,'..'),env:process.env,windowsHide:true,stdio:'ignore'});
    child.on('error',()=>resolve(1)); child.on('exit',resolve);
  });
  for (const status of ['pending','sent','failed']) await t.test('rejects '+status,async () => {
    const {f,row} = await pending();
    if(status==='sent') await f.webhook.drain(f.sendMock);
    if(status==='failed') await db.runAsync("UPDATE whatsapp_messages SET status='failed' WHERE id=$1",[row.id]);
    await assert.rejects(abandon(f,{...row,operation_token:randomUUID()}));
    assert.equal((await state(row.id)).status,status); assert.equal(await receipt(row.id),undefined);
    // Do not leave an unrelated pending test message for later drains.
    if(status==='pending') await db.runAsync("UPDATE whatsapp_messages SET status='failed' WHERE id=$1",[row.id]);
  });
  await t.test('incident class: one transport, audited terminal, same contact starts a fresh flow',async () => {
    const {f,row} = await incident();
    const oldName = f.payload('hugo',{phone});
    await f.webhook.processarWebhookEvolution(oldName,f.headers,{deferDelivery:true});
    await db.runAsync("UPDATE whatsapp_conversations SET expires_at=clock_timestamp()-interval '1 second' WHERE assinatura_id=$1",[f.tenant]);
    await require('../services/whatsapp/conversationStore').createConversationProcessor(db).consumePending();
    await abandon(f,row); await abandon(f,row);
    const after = await state(row.id), audit = await receipt(row.id);
    assert.equal(after.status,'failed'); assert.equal(after.sent_at,null); assert.equal(after.attempts,1);
    for(const key of ['dispatch_started_at','claimed_at','response','phone','instance','assinatura_id','message_id']) assert.deepEqual(after[key],row[key]);
    assert.match(after.last_error,/outcome unknown; retry prohibited/);
    assert.equal(audit.outcome,'abandoned_unknown'); assert.equal(audit.instance_name,f.instance);
    assert.equal(audit.operation_token,row.operation_token); assert.equal(audit.claim_token,row.claim_token);
    assert.equal(audit.previous_last_error,row.last_error);
    assert.equal((await owner(f)).operation_token,null);
    for(const outcome of ['accepted','rejected','not_accepted']) {
      await assert.rejects(abandon(f,row,{outcome}));
      await assert.rejects(delivery.reconcile('whatsapp_messages',row.id,f.tenant,null,{stopped:true,outcome}));
    }
    await assert.rejects(abandon(f,row,{expectedInstance:'wrong-instance'}));
    await f.webhook.drain(()=>assert.fail('old delivery must never call transport again'));
    const fresh = f.payload('oi',{phone});
    await f.webhook.processarWebhookEvolution(fresh,f.headers,{deferDelivery:true});
    let newCalls=0;
    await f.webhook.drain(async()=>{newCalls++;return f.sendMock();});
    assert.equal(newCalls,1); assert.equal((await f.state(phone)).state.step,'ASK_NAME');
    const name=f.payload('hugo',{phone});
    await f.webhook.processarWebhookEvolution(name,f.headers,{deferDelivery:true});
    await f.webhook.drain(f.sendMock);
    assert.equal((await f.state(phone)).state.step,'MENU');
    assert.equal((await db.getAsync('SELECT nome FROM clientes WHERE assinatura_id=$1 AND telefone=$2',[f.tenant,phone])).nome,'hugo');
    assert.equal((await state(row.id)).attempts,1); assert.equal((await state(row.id)).status,'failed');
    await f.webhook.processarWebhookEvolution(fresh,f.headers,{deferDelivery:true});
    await f.webhook.processarWebhookEvolution(oldName,f.headers,{deferDelivery:true});
    await f.webhook.drain(()=>assert.fail('old or duplicate inbound cannot create transport'));
  });
  await t.test('requires stopped attestation, current instance, tenant and exact token',async()=>{
    const {f,row}=await incident();
    for(const extra of [{stopped:false},{stopped:undefined},{expectedInstance:undefined},{expectedInstance:'wrong'}]) await assert.rejects(abandon(f,row,extra));
    await assert.rejects(delivery.reconcile('whatsapp_messages',row.id,f.tenant+100000,row.operation_token,{stopped:true,outcome:'abandoned_unknown',expectedInstance:f.instance}));
    await assert.rejects(abandon(f,{...row,operation_token:randomUUID()}));
    await assert.rejects(abandon(f,{...row,id:row.id+100000}));
    assert.equal((await owner(f)).operation_token,row.operation_token); assert.equal((await state(row.id)).status,'uncertain');
  });
  for (const status of ['pending','sent','failed']) await t.test('rejects '+status+' even with matching live ownership and tokens',async()=>{
    const {f,row}=await incident();
    // Synthetic corruption/legacy fixture only: retain the genuine reservation
    // so rejection proves the delivery-state check, not a token mismatch.
    await db.transaction(async client=>{
      await client.getAsync("SELECT set_config('studiofy.delivery_reconciliation',$1,true)",[row.claim_token]);
      await client.runAsync('UPDATE whatsapp_messages SET status=$1 WHERE id=$2',[status,row.id]);
    });
    await assert.rejects(abandon(f,row));
    assert.equal((await state(row.id)).status,status);
    assert.equal((await owner(f)).operation_token,row.operation_token);
    assert.equal(await receipt(row.id),undefined);
  });
  await t.test('durable provider acceptance correlation cannot be discarded as unknown',async()=>{
    const {f,row}=await incident();
    await db.runAsync('UPDATE whatsapp_conversation_responses SET provider_message_id=$1 WHERE delivery_id=$2 AND assinatura_id=$3',['synthetic-known-acceptance',row.id,f.tenant]);
    await assert.rejects(abandon(f,row));
    assert.equal((await state(row.id)).status,'uncertain');assert.equal((await owner(f)).operation_token,row.operation_token);
    assert.equal(await receipt(row.id),undefined);
    await abandon(f,row,{outcome:'accepted'});assert.equal((await state(row.id)).status,'sent');
  });
  await t.test('uncertain before transport frontier cannot be disguised as abandoned',async()=>{
    const {f,row}=await pending(),token=randomUUID(),claim=randomUUID();
    await db.runAsync("UPDATE whatsapp_messages SET status='uncertain',operation_token=$1,claim_token=$2 WHERE id=$3",[token,claim,row.id]);
    await db.runAsync('UPDATE evolution_instance_owners SET operation_token=$1,operation_started_at=clock_timestamp() WHERE owner_id=$2',[token,String(f.tenant)]);
    await assert.rejects(abandon(f,{...row,operation_token:token}));
    assert.equal((await owner(f)).operation_token,token); assert.equal(await receipt(row.id),undefined);
  });
  await t.test('two independent processes produce one identical receipt and disposition',async()=>{
    const {f,row}=await incident();
    assert.deepEqual(await Promise.all([childReconcile(f,row),childReconcile(f,row)]),[0,0]);
    assert.equal((await state(row.id)).status,'failed');
    assert.equal((await db.getAsync('SELECT count(*)::int n FROM evolution_delivery_reconciliations WHERE delivery_id=$1',[row.id])).n,1);
  });
  await t.test('conclusive reconciliation and unknown cannot overwrite each other',async()=>{
    const {f,row}=await incident();
    const codes=await Promise.all([childReconcile(f,row),childReconcile(f,row,'accepted')]);
    assert.equal(codes.filter(c=>c===0).length,1);
    const audit=await receipt(row.id),after=await state(row.id);
    assert.equal(after.status,audit.outcome==='accepted'?'sent':'failed');
    if(audit.outcome==='accepted') await assert.rejects(abandon(f,row));
    else await assert.rejects(abandon(f,row,{outcome:'accepted'}));
  });
  await t.test('timeout is not proof of stopped execution, including from another process',async()=>{
    const {f,row}=await pending(),claim=randomUUID();let finish,calls=0;
    await db.runAsync("UPDATE whatsapp_messages SET status='sending',claim_token=$1,claimed_at=clock_timestamp() WHERE id=$2",[claim,row.id]);
    await createEvolutionDelivery(db,{timeoutMs:100}).dispatch('whatsapp_messages',await state(row.id),()=>{calls++;return new Promise(resolve=>{finish=resolve;});});
    const uncertain=await state(row.id);assert.equal(uncertain.status,'uncertain');assert.equal(calls,1);
    await assert.rejects(abandon(f,uncertain));assert.equal(await childReconcile(f,uncertain),1);
    finish(await f.sendMock());
    for(let n=0;n<100;n++) {
      try {await abandon(f,uncertain);break;} catch(error) {if(n===99)throw error;await new Promise(resolve=>setTimeout(resolve,10));}
    }
    assert.equal((await state(row.id)).status,'failed');assert.equal(calls,1);
  });
  await t.test('failure releasing ownership rolls back disposition and receipt atomically',async()=>{
    const {f,row}=await incident();
    const pool={connect:async()=>{const c=await db.pool.connect();return {on:(...a)=>c.on(...a),removeListener:(...a)=>c.removeListener(...a),release:(...a)=>c.release(...a),query:cfg=>{if(cfg.text.includes('SET operation_token=NULL,operation_started_at=NULL'))throw Error('Synthetic release failure');return c.query(cfg);}};}};
    await assert.rejects(createEvolutionDelivery({...db,pool}).reconcile('whatsapp_messages',row.id,f.tenant,row.operation_token,{stopped:true,outcome:'abandoned_unknown',expectedInstance:f.instance}));
    assert.equal((await state(row.id)).status,'uncertain');assert.equal(await receipt(row.id),undefined);
    assert.equal((await owner(f)).operation_token,row.operation_token);
  });
  await t.test('lost COMMIT acknowledgement remains idempotent and cannot clear a later reservation',async()=>{
    const {f,row}=await incident();let lost=false;
    const pool={connect:async()=>{const c=await db.pool.connect();return {on:(...a)=>c.on(...a),removeListener:(...a)=>c.removeListener(...a),release:(...a)=>c.release(...a),query:async cfg=>{const result=await c.query(cfg);if(cfg.text==='COMMIT'&&!lost){lost=true;throw Error('Synthetic acknowledgement loss');}return result;}};}};
    await createEvolutionDelivery({...db,pool}).reconcile('whatsapp_messages',row.id,f.tenant,row.operation_token,{stopped:true,outcome:'abandoned_unknown',expectedInstance:f.instance});
    const later=randomUUID();await db.runAsync('UPDATE evolution_instance_owners SET operation_token=$1,operation_started_at=clock_timestamp() WHERE owner_id=$2',[later,String(f.tenant)]);
    await abandon(f,row);assert.equal((await owner(f)).operation_token,later);
    assert.equal((await state(row.id)).status,'failed');
  });
  for(const outcome of ['accepted','rejected','not_accepted']) await t.test('cannot replace a previous '+outcome+' receipt',async()=>{
    const {f,row}=await incident();await abandon(f,row,{outcome});await assert.rejects(abandon(f,row));
    assert.equal((await receipt(row.id)).outcome,outcome);
    if(outcome==='not_accepted')await db.runAsync("UPDATE whatsapp_messages SET status='failed' WHERE id=$1",[row.id]);
  });
  await t.test('reminder unknown also preserves intent and never reopens its attempt',async()=>{
    await require('./helpers/appointmentTransportPolicy').enableAppointmentTransport(db);
    const f=await fixture(db,{known:false});
    const appointment=await db.runAsync("INSERT INTO agendamentos(assinatura_id,nome_cliente,telefone,servico_nome,preco,data,hora,status) VALUES($1,'Synthetic',$2,'Synthetic',30,'2030-01-02','10:00','confirmado')",[f.tenant,'5511999990001']);
    const row=await db.getAsync('SELECT * FROM appointment_reminders WHERE appointment_id=$1',[appointment.lastID]);
    await require('./helpers/reminderClock').setReminderClock(db,'2030-01-02T12:45:00Z');
    await db.runAsync("UPDATE appointment_reminders SET status='sending',claim_token=$1,claimed_at=clock_timestamp() WHERE id=$2",[randomUUID(),row.id]);
    let calls=0;await delivery.dispatch('appointment_reminders',await db.getAsync('SELECT * FROM appointment_reminders WHERE id=$1',[row.id]),async()=>{calls++;throw Error('Ambiguous synthetic reminder');});
    const before=await db.getAsync('SELECT * FROM appointment_reminders WHERE id=$1',[row.id]);
    assert.equal(before.status,'uncertain',JSON.stringify({error:before.last_error,calls,kind:before.reminder_kind,due:before.due_at,start:before.window_start,end:before.window_end}));
    const options={stopped:true,outcome:'abandoned_unknown',expectedInstance:f.instance};
    await delivery.reconcile('appointment_reminders',row.id,f.tenant,before.operation_token,options);
    await delivery.reconcile('appointment_reminders',row.id,f.tenant,before.operation_token,options);
    const after=await db.getAsync('SELECT * FROM appointment_reminders WHERE id=$1',[row.id]);
    assert.equal(after.status,'failed');assert.equal(after.sent_at,null);assert.equal(after.attempts,before.attempts);
    assert.deepEqual(after.dispatch_started_at,before.dispatch_started_at);assert.equal(calls,1);
    await assert.rejects(delivery.reconcile('appointment_reminders',row.id,f.tenant,before.operation_token,{...options,outcome:'not_accepted'}));
  });
  await t.test('execution guards cannot consume the slots needed for SQL progress',async()=>{
    const {f,row}=await pending();await db.runAsync("UPDATE whatsapp_messages SET status='sending',claim_token=$1,claimed_at=clock_timestamp() WHERE id=$2",[randomUUID(),row.id]);
    const pool={options:{max:2},connect:(...args)=>db.pool.connect(...args)};
    await createEvolutionDelivery({...db,pool}).dispatch('whatsapp_messages',await state(row.id),()=>assert.fail('capacity failure is before transport'));
    const after=await state(row.id);assert.equal(after.status,'pending');assert.equal(after.attempts,0);assert.equal(after.dispatch_started_at,null);
    assert.equal((await owner(f)).operation_token,null);
    await db.runAsync("UPDATE whatsapp_messages SET status='failed' WHERE id=$1",[row.id]);
  });
  await t.test('migration preserves prior receipts and rolls back locally without losing records',async()=>{
    const c=await db.pool.connect(),schema='migration_unknown_'+randomUUID().replaceAll('-','');
    try{
      await c.query('BEGIN');await c.query('CREATE SCHEMA '+schema);await c.query('SET LOCAL search_path TO '+schema);
      await c.query("CREATE TABLE evolution_delivery_reconciliations (delivery_kind text,delivery_id bigint,assinatura_id bigint,outcome text NOT NULL CHECK(outcome IN ('accepted','rejected','not_accepted')))");
      await c.query("INSERT INTO evolution_delivery_reconciliations(outcome) VALUES ('accepted'),('rejected'),('not_accepted')");
      await c.query('SAVEPOINT before_migration');
      await c.query(fs.readFileSync(path.join(__dirname,'../database/migrations/028_abandoned_unknown_delivery.sql'),'utf8'));
      assert.equal((await c.query('SELECT count(*)::int n FROM evolution_delivery_reconciliations')).rows[0].n,3);
      await c.query("INSERT INTO evolution_delivery_reconciliations(outcome,instance_name) VALUES ('abandoned_unknown','synthetic-only')");
      await c.query('ROLLBACK TO before_migration');
      assert.equal((await c.query('SELECT count(*)::int n FROM evolution_delivery_reconciliations')).rows[0].n,3);
      await assert.rejects(c.query("INSERT INTO evolution_delivery_reconciliations(outcome) VALUES ('abandoned_unknown')"));
    } finally {await c.query('ROLLBACK');c.release();}
  });
});
