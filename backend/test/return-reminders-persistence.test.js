const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const { transitionAppointment } = require('../services/agenda');

test('return opportunities: durable completion, snapshots, isolation and atomicity without delivery', async t => {
  const env = require('./helpers/postgres').testEnvironment();
  const db = require('../database');
  await db.ready;
  t.after(async () => { await db.close(); await env.cleanup(); });
  let networkCalls = 0;
  t.mock.method(global, 'fetch', async () => { networkCalls++; throw Error('Network forbidden in persistence tests'); });
  const logs = [];
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) t.mock.method(console, level, (...args) => logs.push(args));
  const owners = [];
  for (let i = 0; i < 2; i++) owners.push((await db.runAsync(
    `INSERT INTO assinaturas(barbearia_nome,responsavel_nome,telefone,metodo_pagamento,dia_vencimento,suporte_numero)
     VALUES ($1,'Owner','11988887777','mercado_pago',5,'11977776666')`, ['Synthetic establishment ' + i])).lastID);
  let sequence = 0;
  const service = async (tenant, name) => (await db.runAsync('INSERT INTO servicos_assinatura(assinatura_id,nome,preco) VALUES ($1,$2,20)', [tenant, name])).lastID;
  const book = async ({ tenant = owners[0], name = 'Serviço criado pelo usuário ✨', phone = '5511999994444', status = 'confirmado', future = false, serviceId } = {}) => {
    serviceId ??= await service(tenant, name);
    const date = new Date(Date.UTC(2020, 0, ++sequence)).toISOString().slice(0, 10);
    const id = (await db.runAsync(`INSERT INTO agendamentos(assinatura_id,nome_cliente,telefone,servico_nome,preco,data,hora,status,studio_service_id)
      VALUES ($1,'Cliente histórico Ágata 👋',$2,$3,20,$4,'10:00',$5,$6)`, [tenant, phone, name, future ? '2099-01-01' : date, status, serviceId])).lastID;
    return { id, tenant, serviceId, name, phone };
  };
  const appointment = a => db.getAsync('SELECT * FROM agendamentos WHERE id=$1 AND assinatura_id=$2', [a.id, a.tenant]);
  const reminders = a => db.allAsync('SELECT * FROM return_reminders WHERE appointment_id=$1 AND assinatura_id=$2', [a.id, a.tenant]);
  const finish = a => transitionAppointment(db, a.tenant, a.id, 'concluido');
  const completed = [];

  for (const name of ['Unha em gel', 'Design de sobrancelha', 'Massagem', 'Corte Degradê', 'Serviço arbitrário 🧡 com acentos çã']) {
    await t.test('completion creates one historical opportunity for ' + name, async () => {
      const a = await book({ name });
      // The appointment snapshot, not the present catalog name, owns the message text.
      await db.runAsync('UPDATE servicos_assinatura SET nome=$1 WHERE id=$2', ['Nome posterior do catálogo', a.serviceId]);
      const before = Date.now(); await finish(a); const after = Date.now();
      const source = await appointment(a), rows = await reminders(a);
      assert.equal(rows.length, 1);
      const r = rows[0]; completed.push({ a, r });
      assert.equal(source.status, 'concluido');
      assert.ok(source.completed_at.getTime() >= before - 1000 && source.completed_at.getTime() <= after + 1000);
      assert.equal(r.completed_at.getTime(), source.completed_at.getTime());
      assert.equal(r.eligible_at.getTime() - r.completed_at.getTime(), 7 * 86400000);
      assert.equal(r.next_attempt_at.getTime(), r.eligible_at.getTime());
      assert.equal(r.customer_name_snapshot, 'Cliente histórico Ágata 👋');
      assert.equal(r.phone_snapshot, a.phone); assert.equal(r.service_name_snapshot, name);
      assert.equal(r.service_identity, 'service:' + a.serviceId); assert.match(r.customer_key, /^[a-f0-9]{64}$/);
      assert.equal(r.status, 'pending'); assert.equal(r.attempts, 0);
      for (const field of ['claim_token', 'claimed_at', 'lease_until', 'dispatch_started_at', 'provider_message_id', 'sent_at']) assert.equal(r[field], null);
    });
  }

  await t.test('reprocessing and repeated completion never duplicate or change the reference time', async () => {
    const { a, r } = completed[0];
    await assert.rejects(finish(a), e => e.statusCode === 409);
    await db.runAsync("UPDATE agendamentos SET status='concluido' WHERE id=$1", [a.id]);
    assert.deepEqual(await reminders(a), [r]);
    await assert.rejects(db.transaction(async c => {
      await c.runAsync('SELECT studiofy_return_group_lock($1,$2,$3)', [r.assinatura_id, r.customer_key, r.service_identity]);
      return c.runAsync(`INSERT INTO return_reminders(assinatura_id,appointment_id,service_identity,customer_key,
      customer_name_snapshot,phone_snapshot,service_name_snapshot,completed_at,eligible_at,next_attempt_at,transport_protocol,historical_snapshot_status,establishment_name_snapshot,historical_snapshot_at,snapshot_version)
      SELECT assinatura_id,appointment_id,service_identity,customer_key,customer_name_snapshot,phone_snapshot,
      service_name_snapshot,completed_at,eligible_at,next_attempt_at,transport_protocol,historical_snapshot_status,establishment_name_snapshot,historical_snapshot_at,snapshot_version FROM return_reminders WHERE id=$1`, [r.id]);
    }), e => e.code === '23505');
  });
  for (const status of ['confirmado', 'cancelado', 'falta']) await t.test(status + ' does not create an opportunity', async () => {
    const a = await book();
    await transitionAppointment(db, a.tenant, a.id, status);
    assert.equal((await appointment(a)).completed_at, null); assert.deepEqual(await reminders(a), []);
  });
  await t.test('future completion fails through both the service and direct database writers', async () => {
    const a = await book({ future: true });
    await assert.rejects(finish(a), e => e.statusCode === 409);
    await assert.rejects(db.runAsync("UPDATE agendamentos SET status='concluido' WHERE id=$1", [a.id]), e => e.code === '23514');
    assert.equal((await appointment(a)).status, 'confirmado'); assert.equal((await appointment(a)).completed_at, null);
    assert.deepEqual(await reminders(a), []);
  });
  await t.test('a native SQL completion also creates the opportunity atomically', async () => {
    const a = await book(); await db.runAsync("UPDATE agendamentos SET status='concluido' WHERE id=$1", [a.id]);
    assert.equal((await reminders(a)).length, 1);
  });
  await t.test('same phone is scoped to its establishment and canonical formatting', async () => {
    const a = await book({ phone: '(11) 99999-4444' });
    const b = await book({ tenant: owners[1], phone: '+55 (11) 99999-4444' });
    await finish(a); await finish(b);
    const ra = (await reminders(a))[0], rb = (await reminders(b))[0];
    assert.equal(ra.customer_key, completed[0].r.customer_key); assert.notEqual(ra.customer_key, rb.customer_key);
    assert.equal(ra.phone_snapshot, '5511999994444'); assert.equal(rb.phone_snapshot, '5511999994444');
    await assert.rejects(transitionAppointment(db, owners[0], b.id, 'concluido'), e => e.statusCode === 404);
    assert.deepEqual(await db.allAsync('SELECT * FROM return_reminders WHERE assinatura_id=$1 AND appointment_id=$2', [owners[0], b.id]), []);
    await assert.rejects(db.runAsync('UPDATE return_reminders SET assinatura_id=$1 WHERE id=$2', [owners[0], rb.id]), e => e.code === '23514');
    await assert.rejects(book({ tenant: owners[1], serviceId: a.serviceId }), e => e.code === '23514');
  });
  await t.test('a different recipient does not inherit the original customer key', async () => {
    const a = await book({ phone: '5511988885555' }); await finish(a);
    const r = (await reminders(a))[0]; assert.equal(r.phone_snapshot, '5511988885555'); assert.notEqual(r.customer_key, completed[0].r.customer_key);
    assert.equal((await appointment(a)).cliente_id, null);
  });
  for (const phone of [null, '', 'FAKE_TOKEN_MARKER', '123', '5511000000000000000']) await t.test('invalid contact cannot authorize an opportunity: case ' + String(phone).length, async () => {
    const a = await book({ phone }); await finish(a);
    assert.equal((await appointment(a)).status, 'concluido'); assert.deepEqual(await reminders(a), []);
  });
  await t.test('completion timestamp and reminder facts cannot be forged after completion', async () => {
    const { a, r } = completed[0];
    for (const [sql, values] of [
      ["UPDATE agendamentos SET completed_at=completed_at-interval '1 day' WHERE id=$1", [a.id]],
      ['UPDATE return_reminders SET phone_snapshot=$1 WHERE id=$2', ['5511988885555', r.id]],
      ["UPDATE return_reminders SET service_identity='service:999999' WHERE id=$1", [r.id]],
      ["UPDATE return_reminders SET eligible_at=eligible_at-interval '1 day' WHERE id=$1", [r.id]],
      ["UPDATE return_reminders SET status='untrusted' WHERE id=$1", [r.id]],
    ]) await assert.rejects(db.runAsync(sql, values), e => e.code === '23514');
    assert.deepEqual(await reminders(a), [r]);
  });
  await t.test('two concurrent completions commit exactly one opportunity', async () => {
    const a = await book(); const results = await Promise.allSettled([finish(a), finish(a)]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(results.filter(r => r.status === 'rejected' && r.reason.statusCode === 409).length, 1);
    assert.equal((await reminders(a)).length, 1);
  });
  await t.test('rollback undoes both status and opportunity', async () => {
    const a = await book();
    await assert.rejects(db.transaction(async c => {
      await transitionAppointment(c, a.tenant, a.id, 'concluido');
      assert.equal((await c.getAsync('SELECT count(*)::int AS n FROM return_reminders WHERE appointment_id=$1', [a.id])).n, 1);
      throw Error('Synthetic transaction rollback');
    }), /Synthetic transaction rollback/);
    assert.equal((await appointment(a)).status, 'confirmado'); assert.equal((await appointment(a)).completed_at, null);
    assert.deepEqual(await reminders(a), []);
  });
  await t.test('identity storage failure rolls back completion instead of omitting a valid opportunity', async () => {
    const a = await book();
    await assert.rejects(db.transaction(async c => {
      await c.runAsync("UPDATE configuracoes SET valor='invalid' WHERE chave='return_customer_key_v1'");
      await transitionAppointment(c, a.tenant, a.id, 'concluido');
    }), e => e.code === '23514');
    assert.equal((await appointment(a)).status, 'confirmado'); assert.deepEqual(await reminders(a), []);
  });
  await t.test('historical completed insert and later no-op update remain without opportunities', async () => {
    const a = await book({ status: 'concluido' });
    await db.runAsync("UPDATE agendamentos SET status='concluido' WHERE id=$1", [a.id]);
    assert.equal((await appointment(a)).completed_at, null); assert.deepEqual(await reminders(a), []);
  });
  for (const zone of ['UTC', 'Pacific/Auckland', 'America/Los_Angeles']) await t.test('seven local calendar days independent of database timezone ' + zone, async () => {
    const a = await book();
    await db.transaction(async c => {
      await c.runAsync('SELECT set_config($1,$2,true)', ['TimeZone', zone]);
      await transitionAppointment(c, a.tenant, a.id, 'concluido');
      const r = await c.getAsync(`SELECT eligible_at=((completed_at AT TIME ZONE 'America/Sao_Paulo')+interval '7 days')
        AT TIME ZONE 'America/Sao_Paulo' AS valid FROM return_reminders WHERE appointment_id=$1`, [a.id]);
      assert.equal(r.valid, true);
      const historical = await c.getAsync(`SELECT (((('2018-10-29 12:00'::timestamp+interval '7 days') AT TIME ZONE 'America/Sao_Paulo')
        AT TIME ZONE 'America/Sao_Paulo')='2018-11-05 12:00'::timestamp) AS valid`);
      assert.equal(historical.valid, true);
    });
  });
  await t.test('no network, payload logging, QR or provider delivery metadata', async () => {
    assert.equal(networkCalls, 0); assert.deepEqual(logs, []);
    assert.equal((await db.getAsync("SELECT count(*)::int AS n FROM return_reminders WHERE status<>'pending' OR dispatch_started_at IS NOT NULL OR sent_at IS NOT NULL")).n, 0);
  });
});

test('migration 016 preserves historical appointments and never backfills', async t => {
  const env = require('./helpers/postgres').testEnvironment();
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const c = await pool.connect();
  t.after(async () => { c.release(); await pool.end(); await env.cleanup(); });
  await c.query('CREATE SCHEMA "' + env.schema + '"');
  await c.query('SET search_path TO "' + env.schema + '", public');
  const directory = path.join(__dirname, '../database/migrations');
  for (const name of fs.readdirSync(directory).filter(n => n.endsWith('.sql') && n < '016_').sort()) await c.query(fs.readFileSync(path.join(directory, name), 'utf8'));
  const owner = (await c.query(`INSERT INTO assinaturas(barbearia_nome,responsavel_nome,telefone,metodo_pagamento,dia_vencimento,suporte_numero)
    VALUES ('Historical','Owner','11988887777','mercado_pago',5,'11977776666') RETURNING id`)).rows[0].id;
  for (const status of ['concluido', 'cancelado', 'falta', 'confirmado']) await c.query(`INSERT INTO agendamentos(assinatura_id,nome_cliente,telefone,servico_nome,data,hora,status)
    VALUES ($1,'Historical customer','5511999994444','Historical service','2020-01-01','10:00',$2)`, [owner, status]);
  const before = (await c.query('SELECT * FROM agendamentos ORDER BY id')).rows;
  await c.query('BEGIN');
  await c.query(fs.readFileSync(path.join(directory, '016_return_reminders.sql'), 'utf8'));
  await c.query('COMMIT');
  const after = (await c.query('SELECT * FROM agendamentos ORDER BY id')).rows;
  assert.deepEqual(after.map(({ completed_at, ...row }) => { assert.equal(completed_at, null); return row; }), before);
  assert.equal((await c.query('SELECT count(*)::int AS n FROM return_reminders')).rows[0].n, 0);
});
