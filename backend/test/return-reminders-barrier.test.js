const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { fixture, accepted } = require('./helpers/returnOutbox');
const { materializeReturnReminders, validateReturnReminder } = require('../services/returnReminders');
const { createEvolutionDelivery } = require('../services/evolutionDelivery');

test('approved persistent return cancellation barrier and origin consistency', { timeout: 120000 }, async t => {
  const f = await fixture(t), { db, q, get } = f;
  const delivery = createEvolutionDelivery(db), materialize = () => materializeReturnReminders(db);
  await f.enable();

  await t.test('E: killed producer before INSERT leaves no message; a fresh process recovers once', async () => {
    const { r } = await f.opportunity();
    const child = f.child(`const db=require('./database');db.ready.then(async()=>{
      const c=await db.pool.connect();await c.query('BEGIN');
      const r=await db.getAsync('SELECT * FROM return_reminders WHERE id=$1',[${r.id}]);
      await c.query('SELECT studiofy_return_group_lock($1,$2,$3)',[r.assinatura_id,r.customer_key,r.service_identity]);
      process.send('before-insert');await new Promise(()=>{});
    }).catch(e=>{console.error(e);process.exit(1)});`);
    await once(child, 'message'); child.kill(); await assert.rejects(child.done);
    assert.equal(await f.outbox(r), undefined);
    await f.child(`const db=require('./database');db.ready.then(async()=>{
      await require('./services/returnReminders').materializeReturnReminders(db);await db.close();
    }).catch(e=>{console.error(e);process.exit(1)});`).done;
    assert.ok((await f.outbox(r)).id);
    await materialize(); assert.equal((await get('SELECT count(*)::int n FROM whatsapp_messages WHERE return_reminder_id=$1', [r.id])).n, 1);
  });

  await t.test('I/J: the latch alone defeats a stale validate result and releases the reserved operation', async () => {
    const { owner, sid, r } = await f.opportunity(); await materialize(); let calls = 0;
    await delivery.dispatch('whatsapp_messages', await f.claim(r), async () => { calls++; return accepted(); }, {
      validate: async () => { await f.complete(owner, sid); return true; },
    });
    let m = await f.outbox(r);
    assert.ok(m.return_cancel_requested_at); assert.equal(m.dispatch_started_at, null);
    assert.equal(m.status, 'pending'); assert.equal(calls, 0);
    assert.equal((await get('SELECT operation_token FROM evolution_instance_owners WHERE owner_id=$1', [String(owner.id)])).operation_token, null);
    await require('../evolutionWebhook').drain(async () => { if ((await f.outbox(r)).status === 'sending') calls++; return accepted(); });
    m = await f.outbox(r); assert.equal(m.status, 'failed'); assert.equal(calls, 0);
    await assert.rejects(q('UPDATE whatsapp_messages SET return_cancel_requested_at=NULL WHERE id=$1', [m.id]), e => e.code === '23514');
  });

  await t.test('Q/AJ: different services are independent and return suppression does not update appointment reminders', async () => {
    const { owner, sid, r } = await f.opportunity(), secondService = await f.service(owner);
    const other = await f.complete(owner, secondService); await materialize();
    const appointmentReminders = (await q('SELECT * FROM appointment_reminders ORDER BY id')).rows;
    await f.complete(owner, sid);
    assert.equal((await f.outbox(r)).status, 'failed');
    assert.equal((await f.outbox(other)).return_cancel_requested_at, null);
    let calls = 0;
    await delivery.dispatch('whatsapp_messages', await f.claim(other), async () => { calls++; return accepted(); });
    assert.equal(calls, 1); assert.equal((await f.outbox(other)).status, 'sent');
    const previousIds = appointmentReminders.map(row => row.id);
    assert.deepEqual((await q('SELECT * FROM appointment_reminders WHERE id=ANY($1::bigint[]) ORDER BY id', [previousIds])).rows, appointmentReminders);
  });

  await t.test('K/M/N: supersession after the frontier retains uncertain and latch across not_accepted reconciliation', async () => {
    const { owner, sid, r } = await f.opportunity(); await materialize(); let calls = 0;
    await delivery.dispatch('whatsapp_messages', await f.claim(r), async () => {
      calls++; await f.complete(owner, sid); throw Error('Synthetic provider acknowledgement lost');
    });
    const m = await f.outbox(r);
    assert.equal(m.status, 'uncertain'); assert.ok(m.return_cancel_requested_at); assert.ok(m.operation_token);
    assert.equal((await f.row(r)).status, 'pending'); assert.ok((await f.row(r)).superseded_at);
    await assert.rejects(q("UPDATE whatsapp_messages SET status='pending',dispatch_started_at=NULL WHERE id=$1", [m.id]), e => e.code === '23514');
    await delivery.reconcile('whatsapp_messages', m.id, owner.id, m.operation_token, { stopped: true, outcome: 'not_accepted' });
    await require('../evolutionWebhook').drain(async () => { if ((await f.outbox(r)).status === 'sending') calls++; return accepted(); });
    assert.equal(calls, 1); assert.equal((await f.outbox(r)).status, 'failed');
  });

  await t.test('the materialization marker cannot commit without its unique outbox and history cannot be truncated', async () => {
    const { r } = await f.opportunity();
    await assert.rejects(db.transaction(async c => {
      await c.runAsync('SELECT studiofy_return_group_lock($1,$2,$3)', [r.assinatura_id, r.customer_key, r.service_identity]);
      await c.runAsync('UPDATE return_reminders SET materialized_at=clock_timestamp() WHERE id=$1', [r.id]);
    }), e => e.code === '23514');
    await materialize();
    await assert.rejects(q('TRUNCATE whatsapp_messages CASCADE'), e => e.code === '23514');
    await assert.rejects(q('TRUNCATE return_reminders CASCADE'), e => e.code === '23514');
    assert.ok(await f.outbox(r));
  });

  await t.test('W/X/Y/Z/AA: actual simulated delivery respects 08:59, 09:00, 17:59 and 18:00 in São Paulo', async () => {
    for (const [iso, allowed] of [['2030-06-03T11:59:00Z', false], ['2030-06-03T12:00:00Z', true],
      ['2030-06-03T20:59:00Z', true], ['2030-06-03T21:00:00Z', false]]) {
      await f.clock(); const { r } = await f.opportunity(); await materialize();
      await f.clock(iso); let calls = 0;
      const m = await f.claim(r);
      await delivery.dispatch('whatsapp_messages', m, async () => { calls++; return accepted(); }, {
        validate: () => validateReturnReminder(db, m),
      });
      assert.equal(calls, Number(allowed), iso);
      assert.equal((await f.outbox(r)).status, allowed ? 'sent' : 'pending', iso);
    }
    await f.clock();
  });

  await t.test('finalized appointment edits are rejected and the captured event remains authoritative', async () => {
    const { r } = await f.opportunity();
    await assert.rejects(q("UPDATE agendamentos SET nome_cliente='Edited contact',telefone='11988880000',servico_nome='Edited label' WHERE id=$1", [r.appointment_id]), e => e.code === '23514');
    await materialize(); const m = await f.outbox(r);
    assert.equal(m.phone, r.phone_snapshot); assert.match(m.response, /Ágata histórica/);
    assert.doesNotMatch(m.response, /Edited/);
    assert.equal(await validateReturnReminder(db, m), true);
  });

  await t.test('AE: producer has no transport, and frontier UPDATE path acquires no source/group locks', () => {
    const producer = fs.readFileSync(path.resolve(__dirname, '../services/returnReminders.js'), 'utf8');
    const dispatcher = fs.readFileSync(path.resolve(__dirname, '../services/returnReminderDispatcher.js'), 'utf8');
    for (const text of [producer, dispatcher]) assert.doesNotMatch(text, /sendText|fetch\s*\(|WPPConnect|enviarTextoInstancia|barbearia-\$\{/i);
    const sql = fs.readFileSync(path.resolve(__dirname, '../database/migrations/024_return_reminder_outbox.sql'), 'utf8');
    const update = sql.slice(sql.indexOf('CREATE FUNCTION studiofy_return_outbox_guard'), sql.indexOf('SELECT * INTO r FROM return_reminders', sql.indexOf('CREATE FUNCTION studiofy_return_outbox_guard')));
    assert.doesNotMatch(update, /pg_(?:try_)?advisory|FOR (?:UPDATE|SHARE)|supersede_group/i);
    assert.match(update, /NEW\.return_cancel_requested_at IS NOT NULL/);
  });
});
