const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { createEvolutionDelivery } = require('../services/evolutionDelivery');
const { createEvolutionOwnershipOperation } = require('../services/evolutionOwnershipOperation');
const accepted = () => ({ key: { id: randomUUID() }, status: 'PENDING' });

test('OWN-FINAL-01: durable transport frontier, recovery and process crashes', { timeout: 180000 }, async t => {
  const env = require('./helpers/postgres').testEnvironment();
  const db = require('../database'); await db.ready;
 await require('./helpers/appointmentTransportPolicy').enableAppointmentTransport(db);
  const delivery = createEvolutionDelivery(db), op = createEvolutionOwnershipOperation(db.pool);
  const q = (sql, args = []) => db.pool.query(sql, args);
  const owner = async () => (await q("SELECT * FROM evolution_instance_owners WHERE owner_id='3908'")).rows[0];
  const state = id => db.getAsync('SELECT * FROM whatsapp_messages WHERE id=$1', [id]);
  const message = (claimed = false) => db.getAsync("INSERT INTO whatsapp_messages(assinatura_id,instance,phone,message_id,response,status,claim_token,claimed_at) VALUES(3908,'boundary-audit-x','5511999990000',$1,$2,$3,$4,CURRENT_TIMESTAMP) RETURNING *", [randomUUID(), randomUUID(), claimed ? 'sending' : 'pending', claimed ? randomUUID() : null]);
  const drain = send => require('../evolutionWebhook').drain(send);
  const expireDelay = () => q('UPDATE whatsapp_messages SET lease_until=0');
  const stale = id => q("UPDATE whatsapp_messages SET claimed_at=CURRENT_TIMESTAMP-interval '3 minutes' WHERE id=$1", [id]);
  const reset = async () => {
    await q('DROP TRIGGER IF EXISTS audit_abort_reservation ON evolution_instance_owners');
    await q('DROP FUNCTION IF EXISTS audit_abort_reservation()');
    await q('UPDATE evolution_instance_owners SET operation_token=NULL,operation_started_at=NULL');
    await q('DELETE FROM evolution_delivery_reconciliations'); await q('DELETE FROM whatsapp_messages'); await q('DELETE FROM agendamentos');
  };
  const abortReservation = async () => {
    await q("CREATE FUNCTION audit_abort_reservation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.operation_token IS NULL AND NEW.operation_token IS NOT NULL THEN RAISE EXCEPTION 'Synthetic reservation rollback'; END IF; RETURN NEW; END $$");
    await q('CREATE TRIGGER audit_abort_reservation BEFORE UPDATE ON evolution_instance_owners FOR EACH ROW EXECUTE FUNCTION audit_abort_reservation()');
  };
  for (const id of [3908, 3909]) await db.runAsync("INSERT INTO assinaturas(id,barbearia_nome,responsavel_nome,telefone,metodo_pagamento,dia_vencimento,suporte_numero,status,proximo_vencimento,whatsapp_session) VALUES($1,'Synthetic Boundary','Owner','11999990000','mercado_pago',5,'','ativo','2099-01-01',$2)", [id, id === 3908 ? 'boundary-audit-x' : 'boundary-audit-y']);
  t.beforeEach(reset); t.after(async () => { await reset(); await db.close(); await env.cleanup(); });

  await t.test('exact PostgreSQL reservation rollback: zero transport, safe requeue, next message proceeds', async () => {
    const first = await message(), next = await message(); await abortReservation(); let calls = 0;
    const send = async (_instance, _phone, text) => { calls++; assert.ok([first.response, next.response].includes(text)); return accepted(); };
    await drain(send); const stored = await state(first.id);
    assert.equal(calls, 0); assert.equal(stored.status, 'pending'); assert.equal(stored.attempts, 0);
    assert.equal(stored.operation_token, null); assert.equal(stored.dispatch_started_at, null); assert.equal((await owner()).operation_token, null);
    await q('DROP TRIGGER audit_abort_reservation ON evolution_instance_owners'); await expireDelay();
    await Promise.all([drain(send), drain(send)]); await drain(send);
    assert.equal(calls, 2); assert.equal((await state(first.id)).status, 'sent'); assert.equal((await state(next.id)).status, 'sent');
    await drain(() => assert.fail('sent cannot be resent'));
  });
  await t.test('connection acquisition failure before BEGIN never creates uncertain without a token', async () => {
    const row = await message(true); let calls = 0;
    await createEvolutionDelivery({ ...db, pool: { connect: async () => { throw Error('Synthetic pool failure'); } } }).dispatch('whatsapp_messages', row, async () => { calls++; return accepted(); });
    assert.equal(calls, 0); assert.equal((await state(row.id)).status, 'pending'); assert.equal((await state(row.id)).operation_token, null);
    await expireDelay(); await drain(async () => { calls++; return accepted(); }); assert.equal(calls, 1);
  });
  await t.test('reminder reservation rollback also has zero transport and safe recovery', async () => {
    await db.runAsync("INSERT INTO agendamentos(assinatura_id,nome_cliente,telefone,servico_nome,preco,data,hora,status) VALUES(3908,'Synthetic','5511999990000','Service',30,'2030-01-02','10:00','confirmado')");
    await abortReservation(); let calls = 0;
    const worker = require('./helpers/reminderClock').createReminderWorker(db, async () => { calls++; return accepted(); }, () => new Date('2030-01-02T12:45:00Z'));
    await worker.drain(); assert.equal(calls, 0);
    let row = await db.getAsync("SELECT * FROM appointment_reminders ORDER BY id LIMIT 1"); assert.equal(row.status, 'pending'); assert.equal(row.dispatch_started_at, null); assert.equal(row.operation_token, null);
    await q('DROP TRIGGER audit_abort_reservation ON evolution_instance_owners'); await q('UPDATE appointment_reminders SET next_attempt_at=NULL'); await worker.drain();
    row = await db.getAsync("SELECT * FROM appointment_reminders ORDER BY id LIMIT 1"); assert.equal(row.status, 'sent'); assert.equal(calls, 1); assert.equal((await owner()).operation_token, null);
    await worker.drain(); assert.equal(calls, 1);
  });
  await t.test('uncertain without any evidence is rejected by the database constraint', async () => {
    const row = await message(true);
    await assert.rejects(q("UPDATE whatsapp_messages SET status='uncertain' WHERE id=$1", [row.id]), e => e.code === '23514');
    assert.equal((await state(row.id)).status, 'sending');
  });
  await t.test('rescheduling preserves sent lifetime evidence; unsent 5m retains uncertainty', async () => {
    const appointment = await db.runAsync("INSERT INTO agendamentos(assinatura_id,nome_cliente,telefone,servico_nome,preco,data,hora,status) VALUES(3908,'Synthetic','5511999990000','Service',30,'2030-01-02','10:00','confirmado')");
    let clock=new Date('2030-01-02T12:45:00Z'),calls=0;
    const worker=require('./helpers/reminderClock').createReminderWorker(db,async()=>{calls++;return accepted();},()=>clock);
    await worker.drain();assert.equal(calls,1);
    const sent=await db.getAsync("SELECT * FROM appointment_reminders WHERE reminder_kind='reminder_15m'");
    await q("UPDATE agendamentos SET hora='11:00' WHERE id=$1",[appointment.lastID]);
    clock=new Date('2030-01-02T13:45:00Z');await worker.drain();assert.equal(calls,1);
    assert.deepEqual(await db.getAsync('SELECT * FROM appointment_reminders WHERE id=$1',[sent.id]),sent);
    clock=new Date('2030-01-02T13:55:00Z');
    await require('./helpers/reminderClock').createReminderWorker(db,async()=>{throw Error('Synthetic response lost');},()=>clock).drain();
    const uncertain=await db.getAsync("SELECT * FROM appointment_reminders WHERE status='uncertain'");assert.ok(uncertain);assert.equal(uncertain.reminder_kind,'reminder_5m');
    await q("UPDATE agendamentos SET hora='12:00' WHERE id=$1",[appointment.lastID]);
    assert.deepEqual(await db.getAsync('SELECT * FROM appointment_reminders WHERE id=$1',[uncertain.id]),uncertain);
  });
  await t.test('operation token lifecycle: committed before frontier, retained as history after sent, fence released', async () => {
    const row = await message(true); assert.equal(row.operation_token, null);
    await delivery.dispatch('whatsapp_messages', row, async () => {
      const current = await state(row.id); assert.ok(current.operation_token); assert.ok(current.dispatch_started_at);
      assert.equal(current.operation_token, (await owner()).operation_token); assert.equal(current.attempts, 1);
      return accepted();
    });
    assert.equal((await state(row.id)).status, 'sent'); assert.ok((await state(row.id)).operation_token); assert.equal((await owner()).operation_token, null);
  });
  await t.test('cancelled pre-transport reminder restarts cleanly when its confirmed appointment is refreshed', async () => {
    const appointment = await db.runAsync("INSERT INTO agendamentos(assinatura_id,nome_cliente,telefone,servico_nome,preco,data,hora,status) VALUES(3908,'Synthetic','5511999990000','Service',30,'2030-01-02','10:00','confirmado')");
    const clock = () => new Date('2030-01-02T12:45:00Z'); let calls = 0;
    await require('./helpers/reminderClock').createReminderWorker(db, async () => { calls++; throw Object.assign(Error('Synthetic local preflight failure'), { deliveryOutcome: 'not_attempted' }); }, clock).drain();
    assert.equal((await db.getAsync("SELECT status FROM appointment_reminders WHERE reminder_kind='reminder_15m' ORDER BY id DESC LIMIT 1")).status, 'pending');
    // This is the persisted state produced by account-access cancellation; the
    // appointment itself remains confirmed. Finalized appointments stay final.
    await q("UPDATE appointment_reminders SET status='cancelled'");
    await q("UPDATE agendamentos SET nome_cliente='Synthetic refreshed' WHERE id=$1", [appointment.lastID]);
    const row = await db.getAsync("SELECT * FROM appointment_reminders WHERE reminder_kind='reminder_15m' ORDER BY id DESC LIMIT 1");
    assert.equal(row.status, 'pending'); assert.equal(row.attempts, 0); assert.equal(row.dispatch_started_at, null); assert.equal(row.claim_token, null); assert.equal(row.operation_token, null);
    await require('./helpers/reminderClock').createReminderWorker(db, async () => { calls++; return accepted(); }, clock).drain();
    assert.equal(calls, 2); assert.equal((await db.getAsync('SELECT status FROM appointment_reminders WHERE id=$1',[row.id])).status, 'sent');
  });
  await t.test('lost frontier write acknowledgement is uncertain even with zero actual mock calls', async () => {
    const row = await message(true); let calls = 0;
    const wrapped = { ...db, runAsync: async (sql, args) => { const result = await db.runAsync(sql, args); if (sql.includes('SET dispatch_started_at=CURRENT_TIMESTAMP,attempts=attempts+1')) throw Error('Synthetic lost frontier acknowledgement'); return result; } };
    await createEvolutionDelivery(wrapped).dispatch('whatsapp_messages', row, async () => { calls++; return accepted(); });
    const stored = await state(row.id); assert.equal(calls, 0); assert.equal(stored.status, 'uncertain'); assert.ok(stored.dispatch_started_at); assert.ok(stored.operation_token);
    await drain(() => assert.fail('possible transport cannot retry automatically'));
    await delivery.reconcile('whatsapp_messages', row.id, 3908, stored.operation_token, { stopped: true, outcome: 'not_accepted' });
    await drain(async () => { calls++; return accepted(); }); assert.equal(calls, 1);
  });
  await t.test('lost provider response after frontier stays uncertain and fenced', async () => {
    const row = await message(); let calls = 0;
    await drain(async () => { calls++; throw Error('Synthetic accepted request, response lost'); });
    const stored = await state(row.id); assert.equal(calls, 1); assert.equal(stored.status, 'uncertain'); assert.ok(stored.dispatch_started_at);
    await delivery.recoverInterrupted('whatsapp_messages'); await drain(() => assert.fail('no automatic retry'));
    assert.equal((await owner()).operation_token, stored.operation_token);
    await delivery.reconcile('whatsapp_messages', row.id, 3908, stored.operation_token, { stopped: true, outcome: 'accepted' });
    await delivery.reconcile('whatsapp_messages', row.id, 3908, stored.operation_token, { stopped: true, outcome: 'accepted' });
    assert.equal((await state(row.id)).status, 'sent');
  });
  await t.test('paused pre-frontier worker is fenced after concurrent recovery, even before its timer expires', async () => {
    const row = await message(true); let resume, entered, oldCalls = 0, newCalls = 0;
    const enteredPromise = new Promise(resolve => { entered = resolve; });
    const work = delivery.dispatch('whatsapp_messages', row, async () => { oldCalls++; return accepted(); }, { validate: async () => { entered(); return new Promise(resolve => { resume = resolve; }); } });
    await enteredPromise; await stale(row.id);
    await Promise.all([delivery.recoverInterrupted('whatsapp_messages'), delivery.recoverInterrupted('whatsapp_messages')]);
    assert.equal((await state(row.id)).status, 'pending'); assert.notEqual((await state(row.id)).claim_token, row.claim_token);
    await Promise.all([drain(async () => { newCalls++; return accepted(); }), drain(async () => { newCalls++; return accepted(); })]);
    resume(true); await work; assert.equal(oldCalls, 0); assert.equal(newCalls, 1); assert.equal((await state(row.id)).status, 'sent');
  });
  await t.test('legacy uncertain with NULL token has explicit, idempotent, owner-safe reconciliation', async () => {
    const row = await message();
    await q("UPDATE whatsapp_messages SET status='uncertain',attempts=1,dispatch_started_at=CURRENT_TIMESTAMP WHERE id=$1", [row.id]);
    await drain(() => assert.fail('legacy uncertainty cannot retry'));
    await op.run(3908, async context => {
      await assert.rejects(delivery.reconcile('whatsapp_messages', row.id, 3908, null, { stopped: true, outcome: 'not_accepted' }), { code: 'INSTANCE_OPERATION_BUSY' });
      assert.equal((await owner()).operation_token, context.operationToken);
    });
    await assert.rejects(delivery.reconcile('whatsapp_messages', row.id, 3909, null, { stopped: true, outcome: 'not_accepted' }));
    await assert.rejects(delivery.reconcile('whatsapp_messages', row.id, 3908, null, { outcome: 'not_accepted' }));
    await delivery.reconcile('whatsapp_messages', row.id, 3908, null, { stopped: true, outcome: 'not_accepted' });
    await delivery.reconcile('whatsapp_messages', row.id, 3908, null, { stopped: true, outcome: 'not_accepted' });
    assert.equal((await state(row.id)).status, 'pending'); assert.ok((await state(row.id)).claim_token); assert.equal((await state(row.id)).dispatch_started_at, null);
    let calls = 0; await drain(async () => { calls++; return accepted(); }); assert.equal(calls, 1);
    await delivery.reconcile('whatsapp_messages', row.id, 3908, null, { stopped: true, outcome: 'not_accepted' });
    assert.equal((await state(row.id)).status, 'sent');
  });

  await t.test('late-imported legacy sending without a claim is uncertain, never automatically retried', async () => {
    const row = await message(); let calls = 0;
    await q("UPDATE whatsapp_messages SET status='sending',attempts=1,claimed_at=CURRENT_TIMESTAMP-interval '3 minutes' WHERE id=$1", [row.id]);
    const send = async () => { calls++; return accepted(); };
    await delivery.dispatch('whatsapp_messages', await state(row.id), send);
    await drain(send);
    const stored = await state(row.id); assert.equal(calls, 0); assert.equal(stored.status, 'uncertain'); assert.equal(stored.claim_token, null); assert.equal(stored.operation_token, null); assert.ok(stored.dispatch_started_at);
    await drain(send); assert.equal(calls, 0);
    await delivery.reconcile('whatsapp_messages', row.id, 3908, null, { stopped: true, outcome: 'not_accepted' });
    await drain(send); assert.equal(calls, 1); assert.equal((await state(row.id)).status, 'sent');
  });
  for (const phase of ['before_reserve', 'during_reserve', 'after_reserve', 'before_external', 'external_started', 'accepted', 'finalizing']) {
    await t.test('real process crash: ' + phase, async () => {
      const row = await message(true);
      const code = `const db=require('./database');const phase=${JSON.stringify(phase)};const pause=async()=>{process.send({type:'phase'});await new Promise(()=>{});};db.ready.then(async()=>{const row=await db.getAsync('SELECT * FROM whatsapp_messages WHERE id=$1',[${row.id}]);const pool={connect:async()=>{const c=await db.pool.connect();if(phase==='before_reserve')await pause();return {on:(...a)=>c.on(...a),removeListener:(...a)=>c.removeListener(...a),release:(...a)=>c.release(...a),query:async cfg=>{if(phase==='accepted'&&cfg.text.includes('SET status=$1,last_error=$2,dispatch_started_at='))await pause();const result=await c.query(cfg);if(phase==='during_reserve'&&cfg.text.includes('SET operation_token=$1,operation_started_at='))await pause();if(phase==='finalizing'&&cfg.text.includes('SET operation_token=NULL,operation_started_at=NULL'))await pause();return result;}};}};const api={...db,pool,runAsync:async(sql,args)=>{const frontier=sql.includes('SET dispatch_started_at=CURRENT_TIMESTAMP,attempts=attempts+1');if(frontier&&phase==='after_reserve')await pause();const result=await db.runAsync(sql,args);if(frontier&&phase==='before_external')await pause();return result;}};await require('./services/evolutionDelivery').createEvolutionDelivery(api).dispatch('whatsapp_messages',row,async()=>{process.send({type:'transport'});if(phase==='external_started')await pause();return {key:{id:'synthetic-crash-acceptance'},status:'PENDING'};});}).catch(e=>{console.error(e);process.exitCode=1});`;
      const child = spawn(process.execPath, ['-e', code], { cwd: path.join(__dirname, '..'), env: process.env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      let childCalls = 0, errors = ''; child.stderr.on('data', chunk => { errors += chunk; });
      const exited = new Promise(resolve => child.once('exit', resolve));
      try {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(Error('Crash phase not reached: ' + phase + ': ' + errors)), 12000);
          child.on('message', event => { if (event.type === 'transport') childCalls++; if (event.type === 'phase') { clearTimeout(timer); resolve(); } });
          child.once('error', reject); child.once('exit', () => { clearTimeout(timer); reject(Error('Child exited before crash barrier: ' + errors)); });
        });
        child.kill(); await exited;
        const before = await state(row.id), crossed = !['before_reserve', 'during_reserve', 'after_reserve'].includes(phase);
        assert.equal(Boolean(before.dispatch_started_at), crossed);
        assert.equal(Boolean(before.operation_token), !['before_reserve', 'during_reserve'].includes(phase));
        assert.equal(childCalls, ['external_started', 'accepted', 'finalizing'].includes(phase) ? 1 : 0);
        await stale(row.id); await delivery.recoverInterrupted('whatsapp_messages');
        if (crossed) {
          const stored = await state(row.id); assert.equal(stored.status, 'uncertain'); assert.ok((await owner()).operation_token);
          await drain(() => assert.fail('post-frontier crash cannot automatically retry'));
          await delivery.reconcile('whatsapp_messages', row.id, 3908, stored.operation_token, { stopped: true, outcome: phase === 'before_external' ? 'not_accepted' : 'accepted' });
        } else {
          assert.equal((await state(row.id)).status, 'pending'); assert.equal((await owner()).operation_token, null);
        }
        const next = await message(); let calls = 0; const seen = new Set();
        const send = async (_instance, _phone, text) => { calls++; assert.ok(!seen.has(text), 'No logical message is sent twice'); seen.add(text); return accepted(); };
        await Promise.all([drain(send), drain(send)]); await drain(send);
        assert.equal(calls, crossed && phase !== 'before_external' ? 1 : 2);
        assert.equal((await state(row.id)).status, 'sent'); assert.equal((await state(next.id)).status, 'sent'); assert.equal((await owner()).operation_token, null);
        await drain(() => assert.fail('sent cannot retry after restart'));
      } finally { if (child.exitCode === null) { child.kill(); await exited; } }
    });
  }

  await t.test('two processes explicitly reconcile a legacy NULL token once without releasing a later fence', async () => {
    const row = await message();
    await q("UPDATE whatsapp_messages SET status='uncertain',dispatch_started_at=CURRENT_TIMESTAMP WHERE id=$1", [row.id]);
    const code = `const db=require('./database');db.ready.then(()=>require('./services/evolutionDelivery').createEvolutionDelivery(db).reconcile('whatsapp_messages',${row.id},3908,null,{stopped:true,outcome:'not_accepted'})).then(()=>db.close()).catch(e=>{console.error(e);process.exitCode=1});`;
    const run = () => new Promise((resolve, reject) => { const child = spawn(process.execPath, ['-e', code], { cwd: path.join(__dirname, '..'), env: process.env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] }); let error = ''; child.stderr.on('data', chunk => { error += chunk; }); child.once('error', reject); child.once('exit', exit => exit === 0 ? resolve() : reject(Error(error))); });
    await Promise.all([run(), run()]);
    assert.equal((await state(row.id)).status, 'pending'); assert.equal((await db.getAsync('SELECT count(*)::int n FROM evolution_delivery_reconciliations')).n, 1);
    await op.run(3908, async context => {
      await delivery.reconcile('whatsapp_messages', row.id, 3908, null, { stopped: true, outcome: 'not_accepted' });
      assert.equal((await owner()).operation_token, context.operationToken);
    });
  });
  await t.test('two processes recover and reprocess one pre-frontier claim once', async () => {
    const row = await message(true); await stale(row.id);
    const code = "const db=require('./database');db.ready.then(()=>require('./evolutionWebhook').drain(async()=>{process.send('sent');return {key:{id:'synthetic-multiprocess'},status:'PENDING'}})).then(()=>db.close()).catch(e=>{console.error(e);process.exitCode=1});";
    let calls = 0;
    const run = () => new Promise((resolve, reject) => { const child = spawn(process.execPath, ['-e', code], { cwd: path.join(__dirname, '..'), env: process.env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }); let error = ''; child.on('message', () => { calls++; }); child.stderr.on('data', chunk => { error += chunk; }); child.once('error', reject); child.once('exit', exit => exit === 0 ? resolve() : reject(Error(error))); });
    await Promise.all([run(), run()]); assert.equal(calls, 1); assert.equal((await state(row.id)).status, 'sent'); assert.equal((await owner()).operation_token, null);
  });
});
