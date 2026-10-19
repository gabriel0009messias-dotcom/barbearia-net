const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, accepted } = require('./helpers/returnOutbox');
const { materializeReturnReminders } = require('../services/returnReminders');
const { createEvolutionDelivery } = require('../services/evolutionDelivery');

test('return integration: shared webhook worker, deferred FIFO and existing delivery ownership', { timeout: 90000 }, async t => {
  const f = await fixture(t), { db, q } = f;
  const webhook = require('../evolutionWebhook'), delivery = createEvolutionDelivery(db);
  const calls = [];
  const send = async (...args) => { calls.push(args); return accepted(); };
  await f.enable();
  async function generic(owner, phone = '5511999996060') {
    return (await q(`INSERT INTO whatsapp_messages(assinatura_id,instance,phone,message_id,response)
      VALUES($1,$2,$3,gen_random_uuid()::text,'Existing chat response') RETURNING *`, [owner.id, owner.whatsapp_session, phone])).rows[0];
  }
  await t.test('shared worker materializes and sends return once; the source never claims transport', async () => {
    const { owner, r } = await f.opportunity();
    await Promise.all([webhook.drain(send), webhook.drain(send)]);
    await webhook.drain(send);
    assert.equal(calls.length, 1); assert.equal(calls[0][0], owner.whatsapp_session); assert.equal(calls[0][1], r.phone_snapshot);
    assert.equal((await f.outbox(r)).status, 'sent'); assert.equal((await f.outbox(r)).attempts, 1);
    assert.equal((await f.row(r)).attempts, 0); assert.equal((await f.row(r)).status, 'pending');
  });
  for (const disabled of [false, true]) await t.test((disabled ? 'disabled' : 'out-of-window') + ' older pending return does not block existing chat', async () => {
    await f.enable(); await f.clock(); const { owner, r } = await f.opportunity();
    await materializeReturnReminders(db); const chat = await generic(owner), before = calls.length;
    if (disabled) await f.enable(false); else await f.clock('2030-06-03T21:00:00Z');
    await webhook.drain(send);
    assert.equal(calls.length, before + 1); assert.equal(calls.at(-1)[2], chat.response);
    assert.equal((await f.outbox(r)).status, 'pending'); assert.equal((await f.outbox(r)).attempts, 0);
    await f.enable(); await f.clock(); await webhook.drain(send); assert.equal((await f.outbox(r)).status, 'sent');
  });
  await t.test('older return in backoff does not block chat; later return delivery still uses its original binding', async () => {
    const { owner, r } = await f.opportunity(); await materializeReturnReminders(db); const m = await f.outbox(r);
    await q('UPDATE whatsapp_messages SET lease_until=$1 WHERE id=$2', [Date.now() + 300000, m.id]);
    const chat = await generic(owner), before = calls.length;
    await webhook.drain(send); assert.equal(calls.length, before + 1); assert.equal(calls.at(-1)[2], chat.response);
    assert.equal((await f.outbox(r)).status, 'pending');
    await q('UPDATE whatsapp_messages SET lease_until=0 WHERE id=$1', [m.id]);
    await webhook.drain(send); assert.equal((await f.outbox(r)).status, 'sent'); assert.equal((await f.outbox(r)).id, m.id);
  });
  await t.test('uncertain older return blocks later chat until explicit verified reconciliation', async () => {
    const { owner, r } = await f.opportunity(); await materializeReturnReminders(db);
    const m = await f.claim(r);
    await delivery.dispatch('whatsapp_messages', m, async () => { throw Error('Synthetic ambiguity'); });
    const uncertain = await f.outbox(r); assert.equal(uncertain.status, 'uncertain');
    const chat = await generic(owner), before = calls.length;
    await f.enable(false); await webhook.drain(send); assert.equal(calls.length, before);
    assert.equal((await db.getAsync('SELECT status FROM whatsapp_messages WHERE id=$1', [chat.id])).status, 'pending');
    await delivery.reconcile('whatsapp_messages', m.id, owner.id, uncertain.operation_token, { stopped: true, outcome: 'accepted' });
    await webhook.drain(send); assert.equal(calls.length, before + 1); await f.enable();
  });
  await t.test('in-flight older sending return also blocks chat while delivery is disabled', async () => {
    const { owner, r } = await f.opportunity(); await materializeReturnReminders(db); const m = await f.claim(r);
    const chat = await generic(owner), before = calls.length; await f.enable(false);
    await webhook.drain(send); assert.equal(calls.length, before);
    assert.equal((await db.getAsync('SELECT status FROM whatsapp_messages WHERE id=$1', [chat.id])).status, 'pending');
    await delivery.recoverInterrupted('whatsapp_messages', new Date(Date.now() + 1000));
    await f.enable(); await webhook.drain(send); assert.equal((await f.outbox(r)).status, 'sent');
    assert.equal((await db.getAsync('SELECT status FROM whatsapp_messages WHERE id=$1', [chat.id])).status, 'sent');
  });
  await t.test('two application processes share the same outbox claim and invoke mock transport once', async () => {
    const { owner, r } = await f.opportunity();
    await q('CREATE TABLE return_test_transport_calls(tenant bigint NOT NULL)');
    const code = `const db=require('./database');(async()=>{await db.ready;await require('./evolutionWebhook').drain(async()=>{
      await db.runAsync('INSERT INTO return_test_transport_calls(tenant) VALUES($1)',[${owner.id}]);
      return {key:{id:require('node:crypto').randomUUID()},status:'PENDING'};});await db.close();})().catch(e=>{console.error(e);process.exitCode=1;});`;
    await Promise.all([f.child(code).done, f.child(code).done]);
    assert.equal((await db.getAsync('SELECT count(*)::int n FROM return_test_transport_calls WHERE tenant=$1', [owner.id])).n, 1);
    assert.equal((await f.outbox(r)).status, 'sent'); assert.equal((await f.outbox(r)).attempts, 1);
  });
  await t.test('real application startup uses one shared worker and graceful shutdown', async () => {
    const { once } = require('node:events');
    const child = f.child(`process.env.PORT='0';process.env.RETURN_REMINDER_WORKER_MODE='simulated';
      const webhook=require('./evolutionWebhook'),returns=require('./services/returnReminders');let shared=0,legacy=0;
      const start=webhook.startWorker;webhook.startWorker=(...args)=>{shared++;return start(...args);};
      returns.startWorker=()=>{legacy++;throw Error('Unexpected separate return worker');};
      const log=console.log;console.log=(...args)=>{log(...args);if(String(args[0]).includes('Servidor rodando na porta'))process.send({shared,legacy});};
      process.on('message',()=>{process.emit('SIGTERM');process.disconnect();});require('./app');`);
    const [report] = await once(child, 'message'); assert.deepEqual(report, { shared: 1, legacy: 0 });
    child.send('stop'); await child.done;
  });
});
