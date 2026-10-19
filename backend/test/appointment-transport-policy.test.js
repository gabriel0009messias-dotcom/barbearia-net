const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { createReminderWorker } = require('../services/reminders');
const { createEvolutionDelivery } = require('../services/evolutionDelivery');
const { setReminderClock } = require('./helpers/reminderClock');
const { setAppointmentTransportPolicy } = require('./helpers/appointmentTransportPolicy');

test('025 policy: authorization, PostgreSQL frontier and existing delivery lifecycle', { timeout: 180000 }, async t => {
  const env = require('./helpers/postgres').testEnvironment(), db = require('../database'); await db.ready;
  const q = (sql, args = []) => db.pool.query(sql, args), get = (sql, args = []) => db.getAsync(sql, args);
  const key = 'appointment_reminder_transport_policy_v1';
  const policy = (ids = ['6'], enabled = true, scope = 'allowlist') => ({ version: 1, enabled, scope, assinatura_ids: ids });
  const set = value => setAppointmentTransportPolicy(db, value);
  const now = (time = '13:45:00') => setReminderClock(db, '2030-01-02T' + time + '-03:00');
  const accepted = () => ({ key: { id: randomUUID() }, status: 'PENDING' });
  const delivery = createEvolutionDelivery(db);
  let calls, sequence = 0;
  const names = { 1: 'policy-fixture-other', 6: 'policy-fixture-selected' };
  const services = {};
  for (const tenant of [1, 6]) {
    await q(`INSERT INTO assinaturas(id,barbearia_nome,responsavel_nome,telefone,metodo_pagamento,dia_vencimento,
      suporte_numero,status,proximo_vencimento,whatsapp_session)
      VALUES($1,'Synthetic policy establishment','Owner','11999990000','mercado_pago',5,'','ativo','2099-01-01',$2)`, [tenant, names[tenant]]);
    services[tenant] = (await q("INSERT INTO servicos_assinatura(assinatura_id,nome,preco) VALUES($1,'Synthetic policy service',30) RETURNING id", [tenant])).rows[0].id;
  }
  await q('CREATE TABLE policy_test_calls(tenant bigint)');
  async function book(tenant = 6, time = '14:00', date = '2030-01-02') {
    const a = (await q(`INSERT INTO agendamentos(assinatura_id,nome_cliente,telefone,servico_nome,preco,data,hora,status,studio_service_id)
      VALUES($1,$2,'5511999990000','Synthetic policy service',30,$3,$4,'confirmado',$5) RETURNING id`,
    [tenant, 'Synthetic client ' + ++sequence, date, time, services[tenant]])).rows[0];
    return get("SELECT * FROM appointment_reminders WHERE appointment_id=$1 AND reminder_kind='reminder_15m'", [a.id]);
  }
  const state = r => get('SELECT * FROM appointment_reminders WHERE id=$1', [r.id]);
  async function drain(api = db) {
    return createReminderWorker(api, async (...args) => { calls.push(args); return accepted(); }).drain();
  }
  async function claim(r) {
    const token = randomUUID();
    await q("UPDATE appointment_reminders SET status='sending',claim_token=$1,claimed_at=clock_timestamp() WHERE id=$2", [token, r.id]);
    return { ...r, claim_token: token, instance: r.snapshot.instance, phone: r.destination, response: 'Synthetic policy delivery' };
  }
  function child() {
    const code = `const db=require('./database');db.ready.then(async()=>{
      await require('./services/reminders').createReminderWorker(db,async instance=>{
        const row=await db.getAsync('SELECT owner_id FROM evolution_instance_owners WHERE instance_name=$1',[instance]);
        await db.runAsync('INSERT INTO policy_test_calls(tenant) VALUES($1)',[row.owner_id]);
        return {key:{id:require('node:crypto').randomUUID()},status:'PENDING'};
      }).drain();await db.close();}).catch(e=>{console.error(e);process.exitCode=1});`;
    return new Promise((resolve, reject) => {
      const p = spawn(process.execPath, ['-e', code], { cwd: path.resolve(__dirname, '..'), env: { ...process.env }, windowsHide: true });
      let stderr = ''; p.stderr.on('data', x => { stderr += x; }); p.stdout.resume();
      p.once('error', reject); p.once('exit', code => code === 0 ? resolve() : reject(Error(stderr)));
      t.after(() => { if (p.exitCode === null) p.kill(); });
    });
  }
  t.beforeEach(async () => {
    calls = [];
    await q('UPDATE evolution_instance_owners SET operation_token=NULL,operation_started_at=NULL');
    await q('DELETE FROM evolution_delivery_reconciliations');
    await q('DELETE FROM agendamentos'); await q('DELETE FROM policy_test_calls');
    await q('DELETE FROM configuracoes WHERE chave=$1', [key]);
    await q('UPDATE assinaturas SET whatsapp_session=NULL');
    for (const tenant of [1, 6]) await q('UPDATE assinaturas SET whatsapp_session=$1 WHERE id=$2', [names[tenant], tenant]);
    await now();
  });
  t.after(async () => { await db.close(); await env.cleanup(); });

  const denied = [
    ['A absent', null], ['B invalid JSON', '{'], ['C enabled false', policy(['6'], false)],
    ['D empty allowlist', policy([])], ['H all without enabled', { version: 1, scope: 'all', assinatura_ids: [] }],
    ['H all false', policy([], false, 'all')], ['I zero ID', policy(['0'])], ['I negative ID', policy(['-1'])],
    ['I numeric JSON ID', policy([6])], ['I leading zero', policy(['06'])], ['I instance name', policy([names[6]])],
    ['I unsafe integer', policy(['9007199254740992'])], ['I duplicate IDs', policy(['6', '6'])],
    ['I invalid second ID', policy(['6', 'oops'])], ['I global with conflicting IDs', policy(['6'], true, 'all')],
    ['I JSON null', 'null'], ['I JSON array', '[]'], ['I string enabled', { ...policy(), enabled: 'true' }],
    ['I unknown version', { ...policy(), version: 2 }], ['I unknown scope', policy([], true, '*')],
  ];
  for (const [name, value] of denied) await t.test(name + ' blocks and preserves pending, claims, attempts and intent (J/K/L)', async () => {
    const r = await book(); if (value !== null) await set(value);
    assert.equal((await get('SELECT studiofy_appointment_transport_allowed(6) allowed')).allowed, false);
    await drain(); const row = await state(r);
    assert.equal(calls.length, 0); assert.equal(row.status, 'pending'); assert.equal(row.attempts, 0);
    assert.equal(row.claim_token, null); assert.equal(row.operation_token, null); assert.equal(row.dispatch_started_at, null);
  });

  await t.test('E/F/AI allowlist 6 sends only official tenant 6, never tenant 1', async () => {
    const other = await book(1), allowed = await book(); await set(policy()); await drain();
    assert.equal(calls.length, 1); assert.equal(calls[0][0], names[6]);
    assert.equal((await state(allowed)).status, 'sent'); assert.equal((await state(other)).claim_token, null);
    assert.equal((await get("SELECT operation_token FROM evolution_instance_owners WHERE owner_id='1'")).operation_token, null);
  });
  for (const [name, value] of [['G multiple IDs', policy(['1', '6'])], ['H explicit global', policy([], true, 'all')]])
    await t.test(name + ' permits exactly the configured scope', async () => {
      await book(1); await book(); await set(value); await drain(); assert.equal(calls.length, 2);
      assert.deepEqual(new Set(calls.map(c => c[0])), new Set(Object.values(names)));
    });

  await t.test('M/O expired disabled reminders do not catch up after activation', async () => {
    const r = await book(); await now('13:46:00'); await drain(); assert.equal((await state(r)).status, 'expired');
    await set(policy()); await drain(); assert.equal(calls.length, 0); assert.equal((await state(r)).attempts, 0);
    await now('14:00:00'); await drain();
    assert.ok((await q('SELECT status FROM appointment_reminders')).rows.every(r => r.status === 'expired'));
  });
  await t.test('N enable before expiry processes once, preserving the sixty-second boundary', async () => {
    const r = await book(); await drain(); await now('13:45:59'); await set(policy()); await drain();
    assert.equal(calls.length, 1); assert.equal((await state(r)).status, 'sent');
  });
  await t.test('P two workers share one claim', async () => {
    const r = await book(); await set(policy()); await Promise.all([drain(), drain()]);
    assert.equal(calls.length, 1); assert.equal((await state(r)).attempts, 1);
  });
  await t.test('Q/R independent processes and restart share persisted policy and cannot duplicate', async () => {
    const r = await book(); await child(); assert.equal((await state(r)).claim_token, null);
    await set(policy()); await Promise.all([child(), child()]); await child();
    assert.equal((await get('SELECT count(*)::int n FROM policy_test_calls WHERE tenant=6')).n, 1);
    assert.equal((await state(r)).status, 'sent'); assert.equal((await state(r)).attempts, 1);
  });
  await t.test('S policy revoked after SELECT is checked again by the claim trigger', async () => {
    const r = await book(); await set(policy());
    const wrapped = { ...db, transaction: (work, options) => db.transaction(c => work({ ...c, getAsync: async (sql, args) => {
      const row = await c.getAsync(sql, args);
      if (row && sql.includes('SELECT r.* FROM appointment_reminders')) await set(policy([], false));
      return row;
    } }), options) };
    await drain(wrapped); assert.equal(calls.length, 0); assert.equal((await state(r)).claim_token, null);
  });
  await t.test('T/U stale successful validate cannot bypass the PostgreSQL frontier', async () => {
    const r = await book(); await set(policy()); const row = await claim(r);
    await delivery.dispatch('appointment_reminders', row, () => assert.fail('Unauthorized transport'), {
      validate: async () => { await set(policy([], false)); return true; },
    });
    const stored = await state(r); assert.equal(stored.status, 'pending'); assert.equal(stored.attempts, 0);
    assert.equal(stored.dispatch_started_at, null); assert.equal(stored.operation_token, null);
    assert.equal((await get("SELECT operation_token FROM evolution_instance_owners WHERE owner_id='6'")).operation_token, null);
  });
  await t.test('U a SQL caller ignoring JS cannot acquire an unauthorized claim', async () => {
    const r = await book(); await assert.rejects(claim(r), e => e.code === '55P03');
    assert.equal((await state(r)).status, 'pending');
    await set(policy()); const row = await claim(r); await set(policy([], false));
    await assert.rejects(q('UPDATE appointment_reminders SET dispatch_started_at=clock_timestamp(),attempts=attempts+1 WHERE id=$1', [r.id]), e => e.code === '55P03');
    await delivery.recoverInterrupted('appointment_reminders', new Date(Date.now() + 1000));
    assert.equal((await state(r)).status, 'pending'); assert.equal(row.claim_token === (await state(r)).claim_token, false);
  });
  await t.test('worker policy revocation after claim defers instead of turning suspension into failed', async () => {
    const r = await book(); await set(policy());
    const wrapped = { ...db, getAsync: async (sql, args) => {
      const row = await db.getAsync(sql, args);
      if (sql.startsWith('SELECT * FROM assinaturas')) await set(policy([], false));
      return row;
    } };
    await drain(wrapped); assert.equal(calls.length, 0); assert.equal((await state(r)).status, 'pending');
  });
  await t.test('V/X/Z disabling after committed intent preserves sent and cannot reopen it', async () => {
    const r = await book(); await set(policy()); let count = 0;
    await delivery.dispatch('appointment_reminders', await claim(r), async () => {
      assert.ok((await state(r)).dispatch_started_at); await set(policy([], false)); count++; return accepted();
    });
    await drain(); assert.equal(count, 1); assert.equal(calls.length, 0); assert.equal((await state(r)).status, 'sent');
    await assert.rejects(q("UPDATE appointment_reminders SET status='pending' WHERE id=$1", [r.id]), e => e.code === '23514');
  });
  await t.test('W policy writer holding its row causes safe NOWAIT deferral without deadlock', async () => {
    const r = await book(); await set(policy()); const row = await claim(r), c = await db.pool.connect();
    try {
      await c.query('BEGIN'); await c.query('UPDATE configuracoes SET valor=$1 WHERE chave=$2', [JSON.stringify(policy([], false)), key]);
      const started = Date.now();
      await delivery.dispatch('appointment_reminders', row, () => assert.fail('Policy row busy'));
      assert.ok(Date.now() - started < 5000); assert.equal((await state(r)).status, 'pending');
      assert.equal((await state(r)).operation_token, null);
    } finally { await c.query('ROLLBACK'); c.release(); }
    await drain(); assert.equal(calls.length, 1);
  });
  await t.test('W frontier shared policy lock orders a concurrent disable before HTTP without deadlock', async () => {
    const r = await book(); await set(policy()); const row = await claim(r), writer = await db.pool.connect();
    const pid = (await writer.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    let disabled = false;
    const wrapped = { ...db, runAsync: async (sql, args) => {
      if (!sql.includes('SET dispatch_started_at=CURRENT_TIMESTAMP,attempts=attempts+1')) return db.runAsync(sql, args);
      const c = await db.pool.connect(); let pending;
      try {
        await c.query('BEGIN'); const result = await c.query(sql, args);
        pending = writer.query('UPDATE configuracoes SET valor=$1 WHERE chave=$2', [JSON.stringify(policy([], false)), key]).then(() => { disabled = true; });
        let blocked = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          blocked = (await q('SELECT cardinality(pg_blocking_pids($1))>0 blocked', [pid])).rows[0].blocked;
          if (blocked) break;
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.equal(blocked, true); assert.equal(disabled, false);
        await c.query('COMMIT'); await pending; return { changes: result.rowCount };
      } catch (e) { await c.query('ROLLBACK'); if (pending) await pending; throw e; }
      finally { c.release(); }
    } };
    try {
      await createEvolutionDelivery(wrapped).dispatch('appointment_reminders', row, async () => {
        assert.equal(disabled, true); assert.ok((await state(r)).dispatch_started_at); return accepted();
      });
      assert.equal((await state(r)).status, 'sent');
    } finally { writer.release(); }
  });
  for (const outcome of ['accepted', 'rejected', 'not_accepted']) await t.test('Y/Z uncertain and explicit ' + outcome + ' reconciliation work while disabled', async () => {
    const r = await book(); await set(policy()); let count = 0;
    await delivery.dispatch('appointment_reminders', await claim(r), async () => {
      count++; await set(policy([], false)); throw Error('Synthetic acknowledgement lost');
    });
    const uncertain = await state(r); assert.equal(uncertain.status, 'uncertain');
    await drain(); assert.equal(calls.length, 0); assert.equal(count, 1);
    await assert.rejects(q("UPDATE appointment_reminders SET status='pending' WHERE id=$1", [r.id]), e => e.code === '23514');
    await delivery.reconcile('appointment_reminders', r.id, 6, uncertain.operation_token, { stopped: true, outcome });
    assert.equal((await state(r)).status, outcome === 'accepted' ? 'sent' : outcome === 'rejected' ? 'failed' : 'pending');
    await drain(); assert.equal(calls.length, 0);
  });
  await t.test('AA/AB cancelled and rescheduled reminders do not use old contexts', async () => {
    const r = await book(); await set(policy());
    await q("UPDATE agendamentos SET hora='16:00' WHERE id=$1", [r.appointment_id]); await drain();
    assert.equal(calls.length, 0); assert.equal((await state(r)).status, 'cancelled');
    await q("UPDATE agendamentos SET status='cancelado' WHERE id=$1", [r.appointment_id]); await now('15:45:00'); await drain();
    assert.equal(calls.length, 0);
  });
  for (const altered of [false, true]) await t.test('AC/AD missing or changed ownership fails closed ' + altered, async () => {
    const r = await book(); await set(policy());
    await q('UPDATE assinaturas SET whatsapp_session=NULL WHERE id=6');
    if (altered) await q("UPDATE assinaturas SET whatsapp_session='different-policy-fixture' WHERE id=6");
    await drain(); assert.equal(calls.length, 0); assert.equal((await state(r)).status, 'failed');
  });
  await t.test('AE/AF/AG 15m and 5m are independent; legacy20 remains disabled', async () => {
    const r = await book(); await set(policy()); await drain(); await now('13:55:00'); await drain();
    assert.equal(calls.length, 2); assert.ok((await q('SELECT status FROM appointment_reminders')).rows.every(r => r.status === 'sent'));
    await assert.rejects(q('INSERT INTO appointment_reminders(assinatura_id,appointment_id,due_at) VALUES(6,$1,clock_timestamp())', [r.appointment_id]), e => e.code === '23514');
  });
  await t.test('AJ official ID authorizes an arbitrarily named owned instance, not its name', async () => {
    await q("UPDATE assinaturas SET whatsapp_session='unrelated-provider-name' WHERE id=6");
    await book(); await set(policy()); await drain(); assert.equal(calls.length, 1); assert.equal(calls[0][0], 'unrelated-provider-name');
  });
  await t.test('AL no transaction or policy/account/reminder/ownership row lock crosses HTTP callback', async () => {
    const r = await book(); await set(policy());
    await delivery.dispatch('appointment_reminders', await claim(r), async () => {
      const c = await db.pool.connect();
      try {
        await c.query('BEGIN');
        await c.query('SELECT chave FROM configuracoes WHERE chave=$1 FOR UPDATE NOWAIT', [key]);
        await c.query('SELECT id FROM appointment_reminders WHERE id=$1 FOR UPDATE NOWAIT', [r.id]);
        await c.query('SELECT id FROM assinaturas WHERE id=6 FOR UPDATE NOWAIT');
        await c.query("SELECT instance_key FROM evolution_instance_owners WHERE owner_id='6' FOR UPDATE NOWAIT");
      } finally { await c.query('ROLLBACK'); c.release(); }
      return accepted();
    }); assert.equal((await state(r)).status, 'sent');
  });
  await t.test('AK producer still uses shared delivery and contains no parallel transport or instance derivation', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../services/reminders.js'), 'utf8');
    assert.match(source, /delivery\.dispatch\('appointment_reminders'/);
    assert.doesNotMatch(source, /fetch\s*\(|sendText|WPPConnect|barbearia-\$\{/i);
  });
  // Last: a genuine completed source must be preserved until schema cleanup.
  await t.test('AH appointment policy never activates or changes the return7 outbox/flag', async () => {
    const r = await book(6, '10:00', '2020-01-02'); await set(policy([], true, 'all'));
    await q("UPDATE agendamentos SET status='concluido' WHERE id=$1", [r.appointment_id]);
    assert.equal(await get("SELECT valor FROM configuracoes WHERE chave='return_outbox_delivery_enabled'"), undefined);
    const reminder = await get('SELECT * FROM return_reminders WHERE appointment_id=$1', [r.appointment_id]);
    await require('../services/returnReminders').materializeReturnReminders(db);
    assert.equal((await get('SELECT * FROM return_reminders WHERE id=$1', [reminder.id])).materialized_at, null);
    assert.equal((await get('SELECT count(*)::int n FROM whatsapp_messages WHERE return_reminder_id=$1', [reminder.id])).n, 0);
  });
});
