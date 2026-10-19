const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { createEvolutionDelivery } = require('../services/evolutionDelivery');
const { createEvolutionOwnershipOperation } = require('../services/evolutionOwnershipOperation');
const accepted = () => ({ key: { id: randomUUID() }, status: 'PENDING' });

test('OWN-AUD-01: atomic finalization and durable explicit reconciliation', { timeout: 120000 }, async t => {
  const env = require('./helpers/postgres').testEnvironment();
  const db = require('../database'); await db.ready;
 await require('./helpers/appointmentTransportPolicy').enableAppointmentTransport(db);
  const delivery = createEvolutionDelivery(db), op = createEvolutionOwnershipOperation(db.pool);
  const q = (sql, values = []) => db.pool.query(sql, values);
  const owner = async () => (await q("SELECT * FROM evolution_instance_owners WHERE owner_id='1906'")).rows[0];
  const state = async id => db.getAsync('SELECT * FROM whatsapp_messages WHERE id=$1', [id]);
  const message = async (claimed = true) => db.getAsync(
    "INSERT INTO whatsapp_messages(assinatura_id,instance,phone,message_id,response,status,claim_token,claimed_at) VALUES(1906,'finalize-audit-x','5511999990000',$1,'Synthetic only',$2,$3,CURRENT_TIMESTAMP) RETURNING *",
    [randomUUID(), claimed ? 'sending' : 'pending', claimed ? randomUUID() : null]);
  const reset = async () => {
    await q('DROP TRIGGER IF EXISTS audit_slow_finalize ON whatsapp_messages');
    await q('DROP FUNCTION IF EXISTS audit_slow_finalize()');
    await q('UPDATE evolution_instance_owners SET operation_token=NULL,operation_started_at=NULL');
    await q('DELETE FROM evolution_delivery_reconciliations');
    await q('DELETE FROM whatsapp_messages');
    await q('DELETE FROM agendamentos');
  };
  const delayFinalization = async seconds => {
    assert.ok([0.05, 0.25, 3].includes(seconds));
    await q("CREATE FUNCTION audit_slow_finalize() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='sent' AND OLD.status='sending' THEN PERFORM pg_sleep(" + seconds + '); END IF; RETURN NEW; END $$');
    await q('CREATE TRIGGER audit_slow_finalize BEFORE UPDATE ON whatsapp_messages FOR EACH ROW EXECUTE FUNCTION audit_slow_finalize()');
  };
  const legacyTerminal = async status => {
    const row = await message();
    await assert.rejects(op.run(1906, async () => {
      await q('UPDATE whatsapp_messages SET status=$1 WHERE id=$2', [status, row.id]);
      throw Error('Synthetic pre-fix interruption');
    }, { onReserved: (client, context) => client.query('UPDATE whatsapp_messages SET operation_token=$1 WHERE id=$2', [context.operationToken, row.id]) }));
    return state(row.id);
  };
  const wrappedPool = intercept => ({ connect: async () => {
    const client = await db.pool.connect();
    return { on: (...args) => client.on(...args), removeListener: (...args) => client.removeListener(...args),
      release: (...args) => client.release(...args), query: config => intercept(client, config) };
  } });
  const drain = send => require('../evolutionWebhook').drain(send);
  for (const id of [1906, 1907]) await db.runAsync("INSERT INTO assinaturas(id,barbearia_nome,responsavel_nome,telefone,metodo_pagamento,dia_vencimento,suporte_numero,status,proximo_vencimento,whatsapp_session) VALUES($1,'Synthetic Finalization','Owner','11999990000','mercado_pago',5,'','ativo','2099-01-01',$2)", [id, id === 1906 ? 'finalize-audit-x' : 'finalize-audit-y']);
  t.beforeEach(reset);
  t.after(async () => { await reset(); await db.close(); await env.cleanup(); });

  await t.test('accepted: normal finalization commits sent and releases reservation together', async () => {
    const row = await message(); let calls = 0;
    await delivery.dispatch('whatsapp_messages', row, async () => { calls++; assert.ok((await owner()).operation_token); return accepted(); });
    assert.equal(calls, 1); assert.equal((await state(row.id)).status, 'sent'); assert.equal((await owner()).operation_token, null);
    await drain(() => assert.fail('sent cannot retry'));
  });
  await t.test('accepted: SQL delay below its own deadline finalizes atomically', async () => {
    await delayFinalization(0.05); const row = await message();
    await delivery.dispatch('whatsapp_messages', row, accepted);
    assert.equal((await state(row.id)).status, 'sent'); assert.equal((await owner()).operation_token, null);
  });
  await t.test('exact OWN-AUD-01 probe: 250ms SQL finalization exceeds 50ms transport budget safely', async () => {
    await delayFinalization(0.25); const row = await message(); let calls = 0;
    const send = async () => { calls++; return accepted(); };
    await createEvolutionDelivery(db, { timeoutMs: 50 }).dispatch('whatsapp_messages', row, send);
    assert.equal((await state(row.id)).status, 'sent'); assert.equal((await owner()).operation_token, null);
    await message(false); await drain(send); assert.equal(calls, 2);
    await drain(() => assert.fail('neither sent message may retry'));
  });
  await t.test('accepted: SQL statement timeout rolls back sent and retains a reconcilable fence', async () => {
    await delayFinalization(3); const row = await message(); let calls = 0;
    await delivery.dispatch('whatsapp_messages', row, async () => { calls++; return accepted(); });
    const stored = await state(row.id); assert.equal(stored.status, 'uncertain'); assert.equal(stored.operation_token, (await owner()).operation_token);
    await drain(() => assert.fail('uncertain cannot retry'));
    await delivery.reconcile('whatsapp_messages', row.id, 1906, stored.operation_token, { stopped: true, outcome: 'accepted' });
    assert.equal((await state(row.id)).status, 'sent'); assert.equal((await owner()).operation_token, null); assert.equal(calls, 1);
    await q('DROP TRIGGER audit_slow_finalize ON whatsapp_messages');
    await message(false); await drain(accepted); assert.equal((await db.getAsync("SELECT count(*)::int n FROM whatsapp_messages WHERE status='sent'")).n, 2);
  });
  await t.test('accepted: failure between result write and reservation release rolls both back', async () => {
    const row = await message();
    const pool = wrappedPool(async (client, config) => {
      if (config.text.includes('SET operation_token=NULL,operation_started_at=NULL')) throw Error('Synthetic release failure');
      return client.query(config);
    });
    await createEvolutionDelivery({ ...db, pool }).dispatch('whatsapp_messages', row, accepted);
    const stored = await state(row.id); assert.equal(stored.status, 'uncertain'); assert.equal(stored.operation_token, (await owner()).operation_token);
    await delivery.reconcile('whatsapp_messages', row.id, 1906, stored.operation_token, { stopped: true, outcome: 'accepted' });
    assert.equal((await state(row.id)).status, 'sent'); assert.equal((await owner()).operation_token, null);
  });
  await t.test('lost finalization COMMIT acknowledgement leaves sent and released together', async () => {
    const row = await message(); let commits = 0;
    const pool = wrappedPool(async (client, config) => { const result = await client.query(config); if (config.text === 'COMMIT' && ++commits === 2) throw Error('Synthetic acknowledgement loss'); return result; });
    await createEvolutionDelivery({ ...db, pool }).dispatch('whatsapp_messages', row, accepted);
    assert.equal((await state(row.id)).status, 'sent'); assert.equal((await owner()).operation_token, null);
    await drain(() => assert.fail('accepted message cannot retry'));
  });
  await t.test('legacy sent plus retained fence is explicit, accepted-only and never reopened', async () => {
    const row = await legacyTerminal('sent'); assert.ok((await owner()).operation_token);
    for (const outcome of ['not_accepted', 'rejected']) await assert.rejects(delivery.reconcile('whatsapp_messages', row.id, 1906, row.operation_token, { stopped: true, outcome }));
    await delivery.reconcile('whatsapp_messages', row.id, 1906, row.operation_token, { stopped: true, outcome: 'accepted' });
    await delivery.reconcile('whatsapp_messages', row.id, 1906, row.operation_token, { stopped: true, outcome: 'accepted' });
    assert.equal((await state(row.id)).status, 'sent'); assert.equal((await owner()).operation_token, null);
    await message(false); let calls = 0; await drain(async () => { calls++; return accepted(); }); assert.equal(calls, 1);
  });
  await t.test('legacy permanent failure is rejected-only and safely reconciled', async () => {
    const row = await legacyTerminal('failed');
    await assert.rejects(delivery.reconcile('whatsapp_messages', row.id, 1906, row.operation_token, { stopped: true, outcome: 'not_accepted' }));
    await delivery.reconcile('whatsapp_messages', row.id, 1906, row.operation_token, { stopped: true, outcome: 'rejected' });
    assert.equal((await state(row.id)).status, 'failed'); assert.equal((await owner()).operation_token, null);
  });
  await t.test('reminder sent plus retained fence is reconciled twice without reopening or resending', async () => {
    const appointment = await db.runAsync("INSERT INTO agendamentos(assinatura_id,nome_cliente,telefone,servico_nome,preco,data,hora,status) VALUES(1906,'Synthetic','5511999990000','Service',30,'2030-01-02','10:00','confirmado')");
    const row = await db.getAsync('SELECT * FROM appointment_reminders WHERE appointment_id=$1', [appointment.lastID]);
    const claim = randomUUID(); await q("UPDATE appointment_reminders SET status='sending',claim_token=$1 WHERE id=$2", [claim, row.id]);
    let token;
    await assert.rejects(op.run(1906, async () => {
      await q("UPDATE appointment_reminders SET status='sent' WHERE id=$1", [row.id]);
      throw Error('Synthetic pre-fix reminder interruption');
    }, { onReserved: (client, context) => { token = context.operationToken; return client.query('UPDATE appointment_reminders SET operation_token=$1 WHERE id=$2', [token, row.id]); } }));
    await delivery.reconcile('appointment_reminders', row.id, 1906, token, { stopped: true, outcome: 'accepted' });
    await delivery.reconcile('appointment_reminders', row.id, 1906, token, { stopped: true, outcome: 'accepted' });
    assert.equal((await db.getAsync('SELECT status FROM appointment_reminders WHERE id=$1', [row.id])).status, 'sent');
    assert.equal((await owner()).operation_token, null);
    await require('./helpers/reminderClock').createReminderWorker(db, () => assert.fail('sent reminder cannot retry'), () => new Date('2030-01-02T12:45:00Z')).drain();
  });
  await t.test('reconciliation failure rolls back receipt, delivery and release together', async () => {
    const row = await legacyTerminal('sent');
    const pool = wrappedPool(async (client, config) => {
      if (config.text.includes('evolution_delivery_reconciliations') && config.text.startsWith('INSERT')) throw Error('Synthetic receipt failure');
      return client.query(config);
    });
    await assert.rejects(createEvolutionDelivery({ ...db, pool }).reconcile('whatsapp_messages', row.id, 1906, row.operation_token, { stopped: true, outcome: 'accepted' }));
    assert.equal((await state(row.id)).operation_token, row.operation_token); assert.equal((await state(row.id)).claim_token, row.claim_token);
    assert.equal((await owner()).operation_token, row.operation_token);
    assert.equal((await db.getAsync('SELECT count(*)::int n FROM evolution_delivery_reconciliations')).n, 0);
    await delivery.reconcile('whatsapp_messages', row.id, 1906, row.operation_token, { stopped: true, outcome: 'accepted' });
    assert.equal((await owner()).operation_token, null);
  });
  for (const [outcome, status] of [['accepted', 'sent'], ['rejected', 'failed'], ['not_accepted', 'pending']]) await t.test('uncertain reconciliation is durable and idempotent: ' + outcome, async () => {
    const row = await message(); await delivery.dispatch('whatsapp_messages', row, async () => { throw Error('Synthetic unknown outcome'); });
    const token = (await state(row.id)).operation_token;
    await delivery.reconcile('whatsapp_messages', row.id, 1906, token, { stopped: true, outcome });
    await delivery.reconcile('whatsapp_messages', row.id, 1906, token, { stopped: true, outcome });
    assert.equal((await state(row.id)).status, status); assert.equal((await owner()).operation_token, null);
    assert.equal((await db.getAsync('SELECT count(*)::int n FROM evolution_delivery_reconciliations')).n, 1);
    await assert.rejects(delivery.reconcile('whatsapp_messages', row.id, 1906, token, { stopped: true, outcome: outcome === 'accepted' ? 'rejected' : 'accepted' }));
  });
  await t.test('repeated reconciliation never releases a later reservation or reopens sent', async () => {
    const row = await legacyTerminal('sent');
    await delivery.reconcile('whatsapp_messages', row.id, 1906, row.operation_token, { stopped: true, outcome: 'accepted' });
    await op.run(1906, async context => {
      await delivery.reconcile('whatsapp_messages', row.id, 1906, row.operation_token, { stopped: true, outcome: 'accepted' });
      assert.equal((await owner()).operation_token, context.operationToken);
    });
    assert.equal((await state(row.id)).status, 'sent');
  });
  await t.test('retry reconciliation receipt survives a subsequent claim and accepted dispatch', async () => {
    const row = await message(); await delivery.dispatch('whatsapp_messages', row, async () => { throw Error('Synthetic unknown'); });
    const token = (await state(row.id)).operation_token;
    await delivery.reconcile('whatsapp_messages', row.id, 1906, token, { stopped: true, outcome: 'not_accepted' });
    let calls = 0; await drain(async () => { calls++; return accepted(); });
    await delivery.reconcile('whatsapp_messages', row.id, 1906, token, { stopped: true, outcome: 'not_accepted' });
    assert.equal(calls, 1); assert.equal((await state(row.id)).status, 'sent');
  });
  await t.test('wrong owner, wrong token and conflicting receipt do not release ownership', async () => {
    const row = await legacyTerminal('sent');
    await assert.rejects(delivery.reconcile('whatsapp_messages', row.id, 1907, row.operation_token, { stopped: true, outcome: 'accepted' }));
    await assert.rejects(delivery.reconcile('whatsapp_messages', row.id, 1906, randomUUID(), { stopped: true, outcome: 'accepted' }));
    assert.equal((await owner()).operation_token, row.operation_token);
    await delivery.reconcile('whatsapp_messages', row.id, 1906, row.operation_token, { stopped: true, outcome: 'accepted' });
    await assert.rejects(delivery.reconcile('whatsapp_messages', row.id, 1907, row.operation_token, { stopped: true, outcome: 'accepted' }));
  });
  await t.test('running delivery cannot be reconciled; missing stopped confirmation is refused', async () => {
    const row = await message();
    await delivery.dispatch('whatsapp_messages', row, async () => {
      const token = (await state(row.id)).operation_token;
      await assert.rejects(delivery.reconcile('whatsapp_messages', row.id, 1906, token, { outcome: 'accepted' }));
      await assert.rejects(delivery.reconcile('whatsapp_messages', row.id, 1906, token, { stopped: true, outcome: 'accepted' }));
      return accepted();
    });
    assert.equal((await state(row.id)).status, 'sent');
  });
  await t.test('transport timeout keeps uncertain fenced; late acceptance cannot finalize or retry', async () => {
    const row = await message(); let finish;
    await createEvolutionDelivery(db, { timeoutMs: 30 }).dispatch('whatsapp_messages', row, () => new Promise(resolve => { finish = resolve; }));
    const token = (await state(row.id)).operation_token; finish(accepted()); await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal((await state(row.id)).status, 'uncertain'); assert.equal((await owner()).operation_token, token);
    await drain(() => assert.fail('uncertain cannot retry'));
    await delivery.reconcile('whatsapp_messages', row.id, 1906, token, { stopped: true, outcome: 'accepted' });
  });
  await t.test('two independent processes reconcile the same terminal fence exactly once', async () => {
    const row = await legacyTerminal('sent');
    const code = `const db=require('./database');db.ready.then(()=>require('./services/evolutionDelivery').createEvolutionDelivery(db).reconcile('whatsapp_messages',${row.id},1906,'${row.operation_token}',{stopped:true,outcome:'accepted'})).then(()=>db.close()).catch(e=>{console.error(e);process.exitCode=1});`;
    const run = () => new Promise((resolve, reject) => { const child = spawn(process.execPath, ['-e', code], { cwd: path.join(__dirname, '..'), env: process.env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] }); let error = ''; child.stderr.on('data', chunk => { error += chunk; }); child.on('error', reject); child.on('exit', exit => exit === 0 ? resolve() : reject(Error(error))); });
    await Promise.all([run(), run()]);
    assert.equal((await state(row.id)).status, 'sent'); assert.equal((await owner()).operation_token, null);
    assert.equal((await db.getAsync('SELECT count(*)::int n FROM evolution_delivery_reconciliations')).n, 1);
  });
  await t.test('real crash during finalization rolls back both facts; restart requires reconciliation, then unblocks', async () => {
    const row = await message();
    const code = `const db=require('./database');db.ready.then(async()=>{const row=await db.getAsync('SELECT * FROM whatsapp_messages WHERE id=$1',[${row.id}]);const pool={connect:async()=>{const c=await db.pool.connect();return {on:(...a)=>c.on(...a),removeListener:(...a)=>c.removeListener(...a),release:(...a)=>c.release(...a),query:async cfg=>{const result=await c.query(cfg);if(cfg.text.includes('SET operation_token=NULL,operation_started_at=NULL')){process.send('finalizing');await new Promise(()=>{});}return result;}}}};await require('./services/evolutionDelivery').createEvolutionDelivery({...db,pool}).dispatch('whatsapp_messages',row,async()=>({key:{id:'synthetic-child-acceptance'},status:'PENDING'}));});`;
    const child = spawn(process.execPath, ['-e', code], { cwd: path.join(__dirname, '..'), env: process.env, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const exited = new Promise(resolve => child.once('exit', resolve));
    try {
      await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('Child never entered finalization')), 10000); child.once('message', () => { clearTimeout(timer); resolve(); }); child.once('error', reject); });
      child.kill(); await exited;
      assert.equal((await state(row.id)).status, 'sending'); assert.ok((await owner()).operation_token);
      await q("UPDATE whatsapp_messages SET claimed_at=CURRENT_TIMESTAMP-interval '3 minutes' WHERE id=$1", [row.id]);
      await drain(() => assert.fail('crashed accepted delivery cannot retry'));
      const token = (await state(row.id)).operation_token; assert.equal((await state(row.id)).status, 'uncertain');
      await delivery.reconcile('whatsapp_messages', row.id, 1906, token, { stopped: true, outcome: 'accepted' });
      await message(false); let calls = 0; await drain(async () => { calls++; return accepted(); }); assert.equal(calls, 1);
      await drain(() => assert.fail('no repeated acceptance after restart'));
    } finally { if (child.exitCode === null) { child.kill(); await exited; } }
  });
});
