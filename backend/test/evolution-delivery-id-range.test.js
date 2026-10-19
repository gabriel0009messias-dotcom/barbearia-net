const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createEvolutionDelivery } = require('../services/evolutionDelivery');
const { createEvolutionOwnershipResolver } = require('../services/evolutionOwnership');
const { createEvolutionOwnershipOperation } = require('../services/evolutionOwnershipOperation');

test('OWN-PUB-01: receipt IDs preserve the canonical BIGINT range', async t => {
  const env = require('./helpers/postgres').testEnvironment();
  const db = require('../database');
  await db.ready;
  const delivery = createEvolutionDelivery(db);
  const resolver = createEvolutionOwnershipResolver(db);
  const op = createEvolutionOwnershipOperation(db.pool);
  const q = (sql, args = []) => db.pool.query(sql, args);
  const accepted = () => ({ key: { id: randomUUID() }, status: 'PENDING' });
  let businessClock = new Date('2030-01-02T12:45:00Z');
  const clock = () => businessClock;
  const insertOwner = tenant => q("INSERT INTO assinaturas(id,barbearia_nome,responsavel_nome,telefone,metodo_pagamento,dia_vencimento,suporte_numero,status,proximo_vencimento,whatsapp_session) VALUES($1,'Synthetic ID Range','Owner','11999990000','mercado_pago',5,'','ativo','2099-01-01',$2)", [tenant, 'range-test-' + tenant]);
  t.after(async () => { await db.close(); await env.cleanup(); });

  for (const tenant of [1, 2147483647, 2147483648]) {
    await insertOwner(tenant);
    for (const table of ['whatsapp_messages', 'appointment_reminders']) {
      for (const outcome of ['accepted', 'rejected', 'not_accepted']) {
        await t.test(`${tenant}: ${table} / ${outcome}, receipt, replay and next delivery`, async () => {
          businessClock = new Date('2030-01-02T12:45:00Z');
          // Each case uses real migrations, ownership locks and worker claims.
          await q('UPDATE evolution_instance_owners SET operation_token=NULL,operation_started_at=NULL');
          await q('DELETE FROM whatsapp_messages');
          await q('DELETE FROM agendamentos');
          await q('DELETE FROM evolution_delivery_reconciliations');
          const owner = await resolver.resolve(tenant);
          assert.equal(owner.instanceName, 'range-test-' + tenant);
          const createMessage = async (next = false) => {
            if (table === 'whatsapp_messages') return (await q("INSERT INTO whatsapp_messages(assinatura_id,instance,phone,message_id,response) VALUES($1,$2,'5511999990000',$3,$4) RETURNING id", [tenant, owner.instanceName, randomUUID(), randomUUID()])).rows[0].id;
            const appointment = (await q("INSERT INTO agendamentos(assinatura_id,nome_cliente,telefone,servico_nome,preco,data,hora,status) VALUES($1,'Synthetic','5511999990000','Service',30,$2,'10:00','confirmado') RETURNING id", [tenant, next ? '2030-01-03' : '2030-01-02'])).rows[0];
            return (await q('SELECT id FROM appointment_reminders WHERE appointment_id=$1', [appointment.id])).rows[0].id;
          };
          const state = id => db.getAsync('SELECT * FROM ' + table + ' WHERE id=$1', [id]);
          const drain = send => table === 'whatsapp_messages'
            ? require('../evolutionWebhook').drain(send)
            : require('./helpers/reminderClock').createReminderWorker(db, send, clock).drain();
          const id = await createMessage();
          let firstCalls = 0;
          await drain(async instance => { assert.equal(instance, owner.instanceName); firstCalls++; throw Error('Synthetic lost response'); });
          const uncertain = await state(id);
          assert.equal(firstCalls, 1);
          assert.equal(uncertain.status, 'uncertain');
          assert.ok(uncertain.dispatch_started_at);
          assert.ok(uncertain.operation_token);
          await drain(() => assert.fail('uncertain cannot automatically retry'));

          const token = uncertain.operation_token;
          await delivery.reconcile(table, id, tenant, token, { stopped: true, outcome });
          assert.equal((await state(id)).status, outcome === 'accepted' ? 'sent' : outcome === 'rejected' ? 'failed' : 'pending');
          const receipt = await db.getAsync('SELECT * FROM evolution_delivery_reconciliations WHERE operation_token=$1', [token]);
          assert.equal(receipt.assinatura_id, tenant);
          assert.equal(receipt.delivery_id, id);
          assert.equal(receipt.delivery_kind, table);
          assert.equal(receipt.outcome, outcome);
          assert.equal((await db.getAsync('SELECT operation_token FROM evolution_instance_owners WHERE owner_id=$1', [String(tenant)])).operation_token, null);
          await delivery.reconcile(table, id, tenant, token, { stopped: true, outcome });

          // A receipt replay must not release a later operation for this owner.
          await op.run(tenant, async context => {
            await delivery.reconcile(table, id, tenant, token, { stopped: true, outcome });
            assert.equal((await db.getAsync('SELECT operation_token FROM evolution_instance_owners WHERE owner_id=$1', [String(tenant)])).operation_token, context.operationToken);
          });
          let remainingCalls = 0;
          if (table === 'whatsapp_messages') await q('UPDATE whatsapp_messages SET lease_until=0');
          else await q('UPDATE appointment_reminders SET next_attempt_at=NULL');
          await drain(async instance => { assert.equal(instance, owner.instanceName); remainingCalls++; return accepted(); });
          assert.equal(remainingCalls, outcome === 'not_accepted' ? 1 : 0);
          const next = await createMessage(true);
          businessClock = new Date('2030-01-03T12:45:00Z');
          await drain(async instance => { assert.equal(instance, owner.instanceName); remainingCalls++; return accepted(); });
          assert.equal((await state(next)).status, 'sent');
          assert.equal(remainingCalls, outcome === 'not_accepted' ? 2 : 1);
          await drain(() => assert.fail('completed delivery cannot be duplicated'));
          assert.equal((await db.getAsync('SELECT count(*)::int n FROM evolution_delivery_reconciliations WHERE operation_token=$1', [token])).n, 1);
        });
      }
    }
  }

  await t.test('SQL preserves 9223372036854775806 exactly; application rejects unsafe JS IDs before transport', async () => {
    const tenant = '9223372036854775806';
    await insertOwner(tenant);
    const stored = await db.getAsync('SELECT id::text id FROM assinaturas WHERE id=$1', [tenant]);
    assert.equal(stored.id, tenant);
    assert.equal((await db.getAsync('SELECT owner_id FROM evolution_instance_owners WHERE owner_id=$1', [tenant])).owner_id, tenant);
    let calls = 0;
    await assert.rejects(resolver.resolve(tenant), { code: 'INSTANCE_INVALID_TENANT' });
    await assert.rejects(op.run(tenant, async () => { calls++; }), { code: 'INSTANCE_INVALID_TENANT' });
    await assert.rejects(op.run(Number(tenant), async () => { calls++; }), { code: 'INSTANCE_INVALID_TENANT' });
    await assert.rejects(delivery.reconcile('whatsapp_messages', 1, tenant, null, { stopped: true, outcome: 'accepted' }), /reconciliation mismatch/);
    assert.equal(calls, 0);
    assert.equal((await db.getAsync('SELECT operation_token FROM evolution_instance_owners WHERE owner_id=$1', [tenant])).operation_token, null);
    // Do not weaken the existing safe-integer parser to test SQL's wider range.
    // SQL-only rows below prove FK/receipt compatibility, not a real send or an
    // application-level reconciliation for an unsupported JavaScript identity.
    for (const table of ['whatsapp_messages', 'appointment_reminders']) {
      let id;
      if (table === 'whatsapp_messages') id = (await q("INSERT INTO whatsapp_messages(assinatura_id,instance,phone,message_id,response,status,dispatch_started_at) VALUES($1,$2,'5511999990000',$3,'Synthetic','uncertain',CURRENT_TIMESTAMP) RETURNING id", [tenant, 'range-test-' + tenant, randomUUID()])).rows[0].id;
      else {
        const appointment = (await q("INSERT INTO agendamentos(assinatura_id,nome_cliente,telefone,servico_nome,preco,data,hora,status) VALUES($1,'Synthetic','5511999990000','Service',30,'2030-01-03','10:00','confirmado') RETURNING id", [tenant])).rows[0];
        id = (await q('SELECT id FROM appointment_reminders WHERE appointment_id=$1', [appointment.id])).rows[0].id;
        await q("UPDATE appointment_reminders SET status='uncertain',dispatch_started_at=CURRENT_TIMESTAMP WHERE id=$1", [id]);
      }
      await db.transaction(async client => {
        await client.getAsync("SELECT set_config('studiofy.delivery_reconciliation',$1,true)", ['legacy:' + table + ':' + id]);
        await client.runAsync('UPDATE ' + table + " SET status='sent' WHERE id=$1", [id]);
        await client.runAsync("INSERT INTO evolution_delivery_reconciliations(receipt_key,delivery_kind,delivery_id,assinatura_id,outcome) VALUES($1,$2,$3,$4,'accepted') RETURNING receipt_key", ['legacy:' + table + ':' + id, table, id, tenant]);
      });
      assert.equal((await db.getAsync('SELECT assinatura_id::text tenant FROM evolution_delivery_reconciliations WHERE delivery_kind=$1 AND delivery_id=$2', [table, id])).tenant, tenant);
    }
  });

  await t.test('receipt, outbox and reminder tenant columns match canonical BIGINT; registry keeps exact text', async () => {
    const columns = await db.allAsync("SELECT table_name,column_name,data_type FROM information_schema.columns WHERE table_schema=$1 AND ((table_name='assinaturas' AND column_name='id') OR (table_name IN ('whatsapp_messages','appointment_reminders','evolution_delivery_reconciliations') AND column_name='assinatura_id') OR (table_name='evolution_instance_owners' AND column_name='owner_id'))", [env.schema]);
    assert.equal(columns.length, 5);
    for (const column of columns) assert.equal(column.data_type, column.column_name === 'owner_id' ? 'text' : 'bigint');
  });
});
