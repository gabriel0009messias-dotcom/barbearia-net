const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');
const path = require('node:path');
const express = require('express');
const { localMoment } = require('../services/agenda');
const { addDays } = require('../services/whatsapp/scheduling');
const { captureBookingConfirmation, materializeBookingConfirmations, validateBookingConfirmation } = require('../services/bookingConfirmation');
const { createEvolutionDelivery } = require('../services/evolutionDelivery');
const { classifyBrazilianDestination } = require('../services/whatsapp/phone');

test('public booking confirmation: committed snapshots and the existing protected outbox', { timeout: 180000 }, async t => {
  const env = require('./helpers/postgres').testEnvironment();
  Object.assign(process.env, { NODE_ENV: 'test', EVOLUTION_API_URL: '', EVOLUTION_API_KEY: '', EVOLUTION_WEBHOOK_SECRET: '', PUBLIC_APP_URL: 'https://example.test' });
  const db = require('../database'); await db.ready;
  const webhook = require('../evolutionWebhook'), delivery = createEvolutionDelivery(db);
  const q = (sql, values = []) => db.pool.query(sql, values);
  const accepted = () => ({ key: { id: randomUUID() }, status: 'PENDING' });
  const date = addDays(localMoment().date, 3), key = () => randomBytes(32).toString('hex');
  const owners = [];
  for (const [id, name, instance] of [[806, 'Espaço A', 'booking-owner-a-test'], [807, 'Espaço B', 'booking-owner-b-test']]) {
    await q("INSERT INTO assinaturas(id,barbearia_nome,responsavel_nome,telefone,metodo_pagamento,dia_vencimento,suporte_numero,status,proximo_vencimento,public_slug,whatsapp_session,weekly_hours) VALUES($1,$2,'Owner','11999990000','mercado_pago',5,'','ativo','2099-01-01',$3,$4,$5)", [id, name, 'booking-test-' + id, instance, JSON.stringify(Array.from({ length: 7 }, () => [['08:00', '18:00']]))]);
    const service = (await q("INSERT INTO servicos_assinatura(assinatura_id,nome,preco,duracao) VALUES($1,'Massagem histórica',30,30) RETURNING id", [id])).rows[0].id;
    const professional = (await q("INSERT INTO profissionais(assinatura_id,nome) VALUES($1,'Professional') RETURNING id", [id])).rows[0].id;
    await q('INSERT INTO profissional_servicos(assinatura_id,profissional_id,servico_id) VALUES($1,$2,$3)', [id, professional, service]);
    owners.push({ id, name, instance, service, professional });
  }
  const [a, b] = owners;
  const app = express(); app.use(express.json());
  app.use('/api/studiofy', require('../studiofyRoutes')(db, (_req, res) => res.status(401).json({ error: 'Unauthorized' }), async account => require('../services/access').avaliarAcessoAssinatura(account)));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const url = 'http://127.0.0.1:' + server.address().port, httpFetch = global.fetch;
  const body = (owner = a, extra = {}) => ({ nome_cliente: 'Gabriel', telefone: '(75) 99999-9999', servico_id: owner.service, profissional_id: owner.professional, data: date, hora: '10:00', ...extra });
  const request = async (owner = a, data = body(owner), idempotencyKey = key()) => {
    const response = await httpFetch(url + '/api/studiofy/public/booking-test-' + owner.id + '/agendamentos', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) }, body: JSON.stringify(data) });
    return { status: response.status, data: await response.json() };
  };
  const booking = async (owner = a, extra = {}, idempotencyKey) => {
    const response = await request(owner, body(owner, extra), idempotencyKey); assert.equal(response.status, 201, JSON.stringify(response.data));
    return db.getAsync('SELECT * FROM agendamentos WHERE assinatura_id=$1 ORDER BY id DESC LIMIT 1', [owner.id]);
  };
  const origin = id => db.getAsync('SELECT * FROM public_booking_access WHERE appointment_id=$1', [id]);
  const message = id => db.getAsync('SELECT * FROM whatsapp_messages WHERE booking_confirmation_appointment_id=$1', [id]);
  const accountFence = owner => db.getAsync('SELECT operation_token FROM evolution_instance_owners WHERE owner_id=$1', [String(owner.id)]);
  const assertBooking = async id => assert.equal((await db.getAsync('SELECT status FROM agendamentos WHERE id=$1', [id])).status, 'confirmado');
  const claim = async row => {
    const token = randomUUID();
    await q("UPDATE whatsapp_messages SET status='sending',claim_token=$1,claimed_at=CURRENT_TIMESTAMP WHERE id=$2", [token, row.id]);
    return { ...row, claim_token: token };
  };
  const reset = async () => {
    await q('DROP TRIGGER IF EXISTS booking_test_finalize_failure ON whatsapp_messages'); await q('DROP FUNCTION IF EXISTS booking_test_finalize_failure()');
    await q('DROP TRIGGER IF EXISTS booking_test_queue_failure ON whatsapp_messages'); await q('DROP FUNCTION IF EXISTS booking_test_queue_failure()');
    await q('UPDATE evolution_instance_owners SET operation_token=NULL,operation_started_at=NULL');
    await q('DELETE FROM whatsapp_messages'); await q('DELETE FROM agendamentos'); await q('DELETE FROM evolution_delivery_reconciliations'); await q('DELETE FROM public_request_limits');
    for (const owner of owners) {
      await q('UPDATE assinaturas SET whatsapp_session=NULL WHERE id=$1', [owner.id]);
      await q('UPDATE servicos_assinatura SET nome=$1,preco=30 WHERE id=$2', ['Massagem histórica', owner.service]);
    }
    for (const owner of owners) await q('UPDATE assinaturas SET whatsapp_session=$1,barbearia_nome=$2 WHERE id=$3', [owner.instance, owner.name, owner.id]);
  };
  t.beforeEach(reset);
  t.after(async () => { await reset(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await db.close(); await env.cleanup(); });

  await t.test('booking commits its durable origin, then one confirmation is materialized', async () => {
    const row = await booking(); const source = await origin(row.id);
    assert.equal(source.confirmation_snapshot.appointment_id, String(row.id)); assert.equal(source.confirmation_snapshot.assinatura_id, String(a.id));
    assert.equal(await message(row.id), undefined);
    await materializeBookingConfirmations(db); assert.ok(await message(row.id)); assert.ok((await origin(row.id)).confirmation_materialized_at);
    await assertBooking(row.id);
  });
  for (const [label, pattern] of [['customer', /Gabriel/], ['establishment', /Espaço A/], ['historical service', /Massagem histórica/], ['historical price', /R\$\s30,00/], ['date', new RegExp(date.split('-').reverse().join('/'))], ['hour', /10:00/]]) {
    await t.test('persisted confirmation contains ' + label, async () => { const row = await booking(); await materializeBookingConfirmations(db); assert.match((await message(row.id)).response, pattern); });
  }
  await t.test('persisted phone is normalized once to a safe destination', async () => {
    const row = await booking(); await materializeBookingConfirmations(db); assert.equal((await message(row.id)).phone, '5575999999999');
  });
  await t.test('DDD 55 survives public booking and materialization', async () => {
    const row = await booking(a, { telefone: '(55) 99999-9999' }); await materializeBookingConfirmations(db); assert.equal((await message(row.id)).phone, '5555999999999');
  });
  for (const [input, status, destination] of [
    ['(75) 99999-9999', 201, '5575999999999'], ['75 99999-9999', 201, '5575999999999'],
    ['75999999999', 201, '5575999999999'], ['+55 75 99999-9999', 201, '5575999999999'],
    ['5575999999999', 201, '5575999999999'], ['+5575999999999', 201, '5575999999999'],
    ['(55) 99999-9999', 201, '5555999999999'], ['55 99999-9999', 201, '5555999999999'],
    ['+55 55 99999-9999', 201, '5555999999999'],
    ['+55 99999-9999', 201, null], ['+55 9999-9999', 201, null], ['055 99999-9999', 201, null],
    ['123', 400, null], ['5575999999999999', 400, null], ['abc75999999999', 201, null],
    ['', 400, null], [null, 400, null], ['+1 2025550123', 201, null], ['75+999999999', 201, null],
    [75999999999, 201, null],
  ]) await t.test('CONF-AUD-01 HTTP original phone: ' + String(input), async () => {
    const decision = classifyBrazilianDestination(input), calls = [];
    assert.equal(decision.destination, destination);
    const result = await request(a, body(a, { telefone: input, phone_state: 'routable', destination: '5575999999999' }));
    assert.equal(result.status, status, JSON.stringify(result.data));
    let row;
    if (status === 201) {
      row = await db.getAsync('SELECT * FROM agendamentos WHERE assinatura_id=$1', [a.id]);
      const snapshot = (await origin(row.id)).confirmation_snapshot;
      assert.equal(snapshot.phone_state, decision.state); assert.equal(snapshot.telefone, destination);
      assert.ok(!JSON.stringify(result.data).includes('phone_state'));
      assert.ok(!JSON.stringify(result.data).includes(a.instance));
      if (!destination) await assert.rejects(q("INSERT INTO whatsapp_messages(assinatura_id,instance,phone,message_id,response,booking_confirmation_appointment_id) VALUES($1,$2,'5555999999999',$3,'Synthetic',$4)", [a.id, a.instance, 'booking_confirmation:' + row.id, row.id]), e => e.code === '23514');
    }
    await Promise.all([webhook.drain(async (instance, phone) => { calls.push({ instance, phone }); return accepted(); }), webhook.drain(async (instance, phone) => { calls.push({ instance, phone }); return accepted(); })]);
    await webhook.drain(() => assert.fail('repeated worker cannot send again'));
    assert.equal(calls.length, destination ? 1 : 0);
    if (destination) assert.equal(calls[0].phone, destination);
    if (row) {
      await assertBooking(row.id);
      if (!destination) { assert.equal(await message(row.id), undefined); assert.equal((await origin(row.id)).confirmation_blocked_reason, 'invalid_phone'); }
    } else assert.equal((await db.getAsync('SELECT count(*)::int n FROM agendamentos')).n, 0);
  });
  await t.test('structurally accepted but unroutable phone keeps booking valid, with observable blocked origin', async () => {
    const row = await booking(a, { telefone: '00000000000' });
    await webhook.drain(() => assert.fail('invalid phone cannot send'));
    assert.equal((await origin(row.id)).confirmation_blocked_reason, 'invalid_phone'); assert.equal(await message(row.id), undefined); await assertBooking(row.id);
  });
  await t.test('existing public phone validation is preserved', async () => { assert.equal((await request(a, body(a, { telefone: '123' }))).status, 400); assert.equal((await db.getAsync('SELECT count(*)::int n FROM agendamentos')).n, 0); });
  await t.test('same HTTP request and Idempotency-Key return the same booking and one delivery', async () => {
    const k = key(), first = await request(a, body(), k), second = await request(a, body(), k);
    assert.equal(first.status, 201); assert.deepEqual(first, second); await materializeBookingConfirmations(db);
    assert.equal((await db.getAsync('SELECT count(*)::int n FROM agendamentos')).n, 1); assert.equal((await db.getAsync('SELECT count(*)::int n FROM whatsapp_messages')).n, 1);
  });
  await t.test('double click: simultaneous HTTP requests converge to one appointment and confirmation', async () => {
    const k = key(), responses = await Promise.all([request(a, body(), k), request(a, body(), k)]); assert.deepEqual(responses.map(r => r.status), [201, 201]); assert.deepEqual(responses[0], responses[1]);
    await Promise.all([materializeBookingConfirmations(db), materializeBookingConfirmations(db)]); assert.equal((await db.getAsync('SELECT count(*)::int n FROM agendamentos')).n, 1); assert.equal((await db.getAsync('SELECT count(*)::int n FROM whatsapp_messages')).n, 1);
  });
  await t.test('legacy public booking without Idempotency-Key still receives one origin', async () => { const response = await request(a, body(), null); assert.equal(response.status, 201); await materializeBookingConfirmations(db); assert.equal((await db.getAsync('SELECT count(*)::int n FROM whatsapp_messages')).n, 1); });
  await t.test('materializing repeatedly never creates another logical delivery', async () => {
    const row = await booking(); for (let i = 0; i < 3; i++) await materializeBookingConfirmations(db);
    assert.equal((await message(row.id)).message_id, 'booking_confirmation:' + row.id); assert.equal((await db.getAsync('SELECT count(*)::int n FROM whatsapp_messages')).n, 1);
  });
  await t.test('two materializers contend safely on the durable source', async () => {
    const row = await booking(); await Promise.all([materializeBookingConfirmations(db), materializeBookingConfirmations(db)]);
    assert.ok(await message(row.id)); assert.equal((await db.getAsync('SELECT count(*)::int n FROM whatsapp_messages')).n, 1);
  });
  await t.test('two workers deliver one logical confirmation once', async () => {
    const row = await booking(); let calls = 0;
    const send = async instance => { calls++; assert.equal(instance, a.instance); return accepted(); };
    await Promise.all([webhook.drain(send), webhook.drain(send)]); await webhook.drain(send);
    assert.equal(calls, 1); assert.equal((await message(row.id)).status, 'sent'); await assertBooking(row.id);
  });
  await t.test('A uses X and B uses Y exclusively', async () => {
    const first = await booking(a), second = await booking(b), calls = [];
    await webhook.drain(async (instance, phone, text) => { calls.push({ instance, phone, text }); return accepted(); });
    assert.equal(calls.length, 2); assert.equal((await message(first.id)).instance, a.instance); assert.equal((await message(second.id)).instance, b.instance);
    for (const call of calls) assert.ok(call.text.includes(call.instance === a.instance ? a.name : b.name));
  });
  await t.test('owner reassociated before materialization/dispatch: old A never uses B or a new A instance', async () => {
    const row = await booking(a); await q('UPDATE assinaturas SET whatsapp_session=NULL WHERE id=$1', [a.id]); await q('UPDATE assinaturas SET whatsapp_session=$1 WHERE id=$2', [a.instance, b.id]);
    await q("UPDATE assinaturas SET whatsapp_session='booking-new-a-test' WHERE id=$1", [a.id]);
    await webhook.drain(() => assert.fail('crossed owner cannot send'));
    assert.equal((await message(row.id)).instance, a.instance); assert.equal((await message(row.id)).status, 'failed'); await assertBooking(row.id);
  });
  await t.test('missing instance is a safe blocked origin and does not fail booking', async () => {
    await q('UPDATE assinaturas SET whatsapp_session=NULL WHERE id=$1', [a.id]); const row = await booking();
    await webhook.drain(() => assert.fail()); assert.equal((await origin(row.id)).confirmation_blocked_reason, 'instance_not_configured'); await assertBooking(row.id);
  });
  await t.test('owner reassociated AFTER queue materialization is still blocked before dispatch', async () => {
    const row = await booking(); await materializeBookingConfirmations(db);
    await q('UPDATE assinaturas SET whatsapp_session=NULL WHERE id=$1', [a.id]); await q('UPDATE assinaturas SET whatsapp_session=$1 WHERE id=$2', [a.instance, b.id]);
    await webhook.drain(() => assert.fail('materialized A cannot use owner B'));
    assert.equal((await message(row.id)).status, 'failed'); await assertBooking(row.id);
  });
  await t.test('tenant A cannot capture an appointment of B', async () => {
    const row = await booking(b); await assert.rejects(captureBookingConfirmation(db, a.id, row.id), /origin mismatch/); assert.equal((await origin(row.id)).confirmation_snapshot.assinatura_id, String(b.id));
  });
  await t.test('arbitrary HTTP IDs/names/instance and SQL-looking values do not change owner or snapshot', async () => {
    const row = await booking(a, { assinatura_id: b.id, appointment_id: 999999, instanceName: b.instance, estabelecimento: 'FORGED', preco: 9999, servico_nome: "FORGED'; DROP TABLE assinaturas;--" });
    await materializeBookingConfirmations(db); const queued = await message(row.id);
    assert.equal(queued.assinatura_id, a.id); assert.equal(queued.instance, a.instance); assert.ok(!/FORGED|9999/.test(queued.response)); assert.equal((await db.getAsync('SELECT count(*)::int n FROM assinaturas')).n, 2);
    assert.equal((await request(a, body(a, { servico_id: b.service, profissional_id: b.professional }))).status, 409);
  });
  for (const [label, sql, values, preserved] of [
    ['service edit', 'UPDATE servicos_assinatura SET nome=$1 WHERE id=$2', ['Novo serviço', a.service], /Massagem histórica/],
    ['price edit', 'UPDATE servicos_assinatura SET preco=$1 WHERE id=$2', [40, a.service], /R\$\s30,00/],
    ['establishment edit', 'UPDATE assinaturas SET barbearia_nome=$1 WHERE id=$2', ['Nome novo', a.id], /Espaço A/],
  ]) await t.test('old confirmation keeps historical snapshot after ' + label, async () => {
    const row = await booking(); await q(sql, values); await materializeBookingConfirmations(db); assert.match((await message(row.id)).response, preserved);
    assert.equal((await origin(row.id)).confirmation_snapshot.preco, 30);
  });
  await t.test('snapshot and queue delivery identity cannot be rewritten', async () => {
    const row = await booking(); await materializeBookingConfirmations(db);
    await assert.rejects(q("UPDATE public_booking_access SET confirmation_snapshot=jsonb_set(confirmation_snapshot,'{preco}','40') WHERE appointment_id=$1", [row.id]), e => e.code === '23514');
    await assert.rejects(q('UPDATE whatsapp_messages SET assinatura_id=$1 WHERE booking_confirmation_appointment_id=$2', [b.id, row.id]), e => e.code === '23514');
  });
  await t.test('database rejects a second confirmation even using another instance/message identity', async () => {
    const row = await booking(); await materializeBookingConfirmations(db); const queued = await message(row.id);
    await assert.rejects(q('INSERT INTO whatsapp_messages(assinatura_id,instance,phone,message_id,response,booking_confirmation_appointment_id) VALUES($1,$2,$3,$4,$5,$6)', [a.id, a.instance, queued.phone, queued.message_id, queued.response, row.id]), e => e.code === '23505');
  });
  await t.test('database rejects cross-tenant delivery insertion', async () => {
    const row = await booking(); await assert.rejects(q("INSERT INTO whatsapp_messages(assinatura_id,instance,phone,message_id,response,booking_confirmation_appointment_id) VALUES($1,$2,'5575999999999',$3,'Synthetic',$4)", [b.id, b.instance, 'booking_confirmation:' + row.id, row.id]), e => e.code === '23514');
  });
  await t.test('plain confirmation contains no HTML; response and logs contain no extra secrets', async sub => {
    const logs = []; sub.mock.method(console, 'info', (...args) => logs.push(JSON.stringify(args))); sub.mock.method(console, 'error', (...args) => logs.push(JSON.stringify(args)));
    const result = await request(a, body(a, { nome_cliente: '<img src=x onerror=alert(1)>Gabriel', apikey: 'PRIVATE_APIKEY', token: 'PRIVATE_INPUT_TOKEN', webhookSecret: 'PRIVATE_WEBHOOK' }));
    assert.equal(result.status, 201); assert.deepEqual(Object.keys(result.data).sort(), ['agendamento', 'token']);
    await webhook.drain(async () => { throw Error('PRIVATE_PROVIDER_EXCEPTION apikey=PRIVATE_APIKEY'); });
    const queued = await db.getAsync('SELECT * FROM whatsapp_messages'); assert.ok(!/[<>]/.test(queued.response));
    for (const secret of ['PRIVATE_APIKEY', 'PRIVATE_INPUT_TOKEN', 'PRIVATE_WEBHOOK', 'PRIVATE_PROVIDER_EXCEPTION', result.data.token]) assert.ok(!logs.join('').includes(secret));
    for (const secret of ['PRIVATE_APIKEY', 'PRIVATE_INPUT_TOKEN', 'PRIVATE_WEBHOOK']) assert.ok(!JSON.stringify(result.data).includes(secret));
  });
  for (const [label, failure] of [['Evolution offline', { code: 'EVOLUTION_OFFLINE' }], ['network failure', { code: 'ECONNRESET' }], ['provider timeout', { code: 'EVOLUTION_TIMEOUT' }]]) {
    await t.test(label + ': booking stays confirmed, uncertain never automatically retries', async () => {
      const row = await booking(); let calls = 0;
      await webhook.drain(async () => { calls++; throw Object.assign(Error('Synthetic transport failure'), failure); });
      assert.equal((await message(row.id)).status, 'uncertain'); await webhook.drain(() => assert.fail('uncertain cannot retry')); assert.equal(calls, 1); await assertBooking(row.id);
    });
  }
  await t.test('pre-transport acquisition timeout safely recovers without touching booking', async () => {
    const row = await booking(); await materializeBookingConfirmations(db); const queued = await claim(await message(row.id)); let calls = 0;
    await createEvolutionDelivery({ ...db, pool: { connect: () => new Promise(() => {}) } }).dispatch('whatsapp_messages', queued, async () => { calls++; return accepted(); });
    assert.equal(calls, 0); assert.equal((await message(row.id)).status, 'pending'); assert.equal((await message(row.id)).dispatch_started_at, null); await assertBooking(row.id);
    await q('UPDATE whatsapp_messages SET lease_until=0'); await webhook.drain(async () => { calls++; return accepted(); }); assert.equal(calls, 1);
  });
  await t.test('HTTP retry after uncertain delivery still succeeds with the original booking', async () => {
    const k = key(), first = await request(a, body(), k); assert.equal(first.status, 201);
    await webhook.drain(async () => { throw Error('Synthetic offline'); });
    const second = await request(a, body(), k); assert.deepEqual(second, first);
    assert.equal((await db.getAsync('SELECT count(*)::int n FROM agendamentos')).n, 1);
    assert.equal((await db.getAsync('SELECT status FROM whatsapp_messages')).status, 'uncertain');
  });
  await t.test('post-frontier timeout retains fence; late acceptance cannot retry or alter appointment', async () => {
    const row = await booking(); await materializeBookingConfirmations(db); const queued = await claim(await message(row.id)); let finish, calls = 0;
    await createEvolutionDelivery(db, { timeoutMs: 25 }).dispatch('whatsapp_messages', queued, () => { calls++; return new Promise(resolve => { finish = resolve; }); });
    assert.equal((await message(row.id)).status, 'uncertain'); assert.ok((await accountFence(a)).operation_token);
    finish(accepted()); await new Promise(resolve => setImmediate(resolve)); await webhook.drain(() => assert.fail());
    const uncertain = await message(row.id); await delivery.reconcile('whatsapp_messages', uncertain.id, a.id, uncertain.operation_token, { stopped: true, outcome: 'accepted' });
    assert.equal((await message(row.id)).status, 'sent'); assert.equal(calls, 1); await assertBooking(row.id);
  });
  await t.test('accepted plus failed finalization is reconciled once and next confirmation proceeds', async () => {
    const first = await booking();
    await q("CREATE FUNCTION booking_test_finalize_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='sent' AND OLD.status='sending' THEN RAISE EXCEPTION 'Synthetic finalization failure'; END IF; RETURN NEW; END $$");
    await q('CREATE TRIGGER booking_test_finalize_failure BEFORE UPDATE ON whatsapp_messages FOR EACH ROW EXECUTE FUNCTION booking_test_finalize_failure()');
    let calls = 0; await webhook.drain(async () => { calls++; return accepted(); }); assert.equal((await message(first.id)).status, 'uncertain'); await assertBooking(first.id);
    await webhook.drain(() => assert.fail()); await q('DROP TRIGGER booking_test_finalize_failure ON whatsapp_messages');
    const unknown = await message(first.id); await delivery.reconcile('whatsapp_messages', unknown.id, a.id, unknown.operation_token, { stopped: true, outcome: 'accepted' });
    await delivery.reconcile('whatsapp_messages', unknown.id, a.id, unknown.operation_token, { stopped: true, outcome: 'accepted' });
    const next = await booking(a, { hora: '11:00' }); await webhook.drain(async () => { calls++; return accepted(); }); assert.equal(calls, 2); assert.equal((await message(next.id)).status, 'sent'); await assertBooking(next.id);
  });
  await t.test('queue insertion failure preserves committed booking and retryable source', async () => {
    const row = await booking(); await q("CREATE FUNCTION booking_test_queue_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic queue unavailable'; END $$");
    await q('CREATE TRIGGER booking_test_queue_failure BEFORE INSERT ON whatsapp_messages FOR EACH ROW EXECUTE FUNCTION booking_test_queue_failure()');
    await assert.rejects(materializeBookingConfirmations(db)); assert.equal((await origin(row.id)).confirmation_materialized_at, null); await assertBooking(row.id);
    await q('DROP TRIGGER booking_test_queue_failure ON whatsapp_messages'); await materializeBookingConfirmations(db); assert.ok(await message(row.id));
  });
  await t.test('uncommitted booking/source is invisible to another worker; rollback creates no delivery', async () => {
    const connection = await db.pool.connect();
    try {
      await connection.query('BEGIN');
      const sqlDb = { runAsync: async (sql, args) => ({ changes: (await connection.query(sql, args)).rowCount }) };
      const row = (await connection.query("INSERT INTO agendamentos(assinatura_id,nome_cliente,telefone,servico_nome,preco,data,hora,status) VALUES($1,'Synthetic','5575999999999','Service',30,$2,'10:00','confirmado') RETURNING id", [a.id, date])).rows[0];
      await connection.query('INSERT INTO public_booking_access(appointment_id,token_hash) VALUES($1,$2)', [row.id, key()]); await captureBookingConfirmation(sqlDb, a.id, row.id, classifyBrazilianDestination('5575999999999'));
      await materializeBookingConfirmations(db); assert.equal(await message(row.id), undefined);
      await connection.query('ROLLBACK'); await materializeBookingConfirmations(db); assert.equal((await db.getAsync('SELECT count(*)::int n FROM whatsapp_messages')).n, 0);
    } finally { await connection.query('ROLLBACK'); connection.release(); }
  });
  await t.test('HTTP booking does not wait for Evolution even while a transport is stalled', async () => {
    const first = await booking(); let enter, finish, calls=0;
    const entered = new Promise(resolve => { enter = resolve; });
    const worker = webhook.drain(() => { if (++calls>1) return accepted(); enter(); return new Promise(resolve => { finish = resolve; }); });
    await entered;
    try {
      let timer;
      const next = await Promise.race([booking(b), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('HTTP waited for transport')), 2500); })]).finally(() => clearTimeout(timer));
      await assertBooking(first.id); await assertBooking(next.id);
    } finally { finish(accepted()); await worker; }
  });
  await t.test('cancellation before dispatch blocks obsolete confirmation; delivery does not change appointment status', async () => {
    const row = await booking(); await materializeBookingConfirmations(db); await q("UPDATE agendamentos SET status='cancelado' WHERE id=$1", [row.id]);
    await webhook.drain(() => assert.fail('cancelled appointment cannot send')); assert.equal((await message(row.id)).status, 'failed'); assert.equal((await db.getAsync('SELECT status FROM agendamentos WHERE id=$1', [row.id])).status, 'cancelado');
  });

  const runChild = (code, onMessage = () => {}) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', code], { cwd: path.join(__dirname, '..'), env: process.env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let errors = ''; child.stderr.on('data', chunk => { errors += chunk; }); child.on('message', onMessage); child.once('error', reject); child.once('exit', exit => exit === 0 ? resolve() : reject(Error(errors || 'Child failed')));
  });
  await t.test('CONF-AUD-01: rejected original destination survives commit and two restarted worker processes', async () => {
    const row = await booking(a, { telefone: '+55 99999-9999' });
    assert.equal(row.telefone, '5555999999999'); // Legacy booking contract is preserved.
    const snapshot = (await origin(row.id)).confirmation_snapshot;
    assert.equal(snapshot.phone_state, 'invalid'); assert.equal(snapshot.telefone, null);
    assert.equal(await message(row.id), undefined); // Restart is before materialization.
    await assert.rejects(q("UPDATE public_booking_access SET confirmation_snapshot=jsonb_set(jsonb_set(confirmation_snapshot,'{phone_state}','\"routable\"'),'{telefone}','\"5555999999999\"') WHERE appointment_id=$1", [row.id]), e => e.code === '23514');
    const code = "const db=require('./database');db.ready.then(()=>require('./evolutionWebhook').drain(async()=>{process.send('unexpected');return {key:{id:'synthetic'},status:'PENDING'}})).then(()=>db.close()).catch(e=>{console.error(e);process.exitCode=1});";
    let calls = 0; const count = () => { calls++; };
    await Promise.all([runChild(code, count), runChild(code, count)]); await runChild(code, count);
    assert.equal(calls, 0); assert.equal(await message(row.id), undefined); await assertBooking(row.id);
    const source = await origin(row.id); assert.deepEqual(source.confirmation_snapshot, snapshot);
    assert.equal(source.confirmation_blocked_reason, 'invalid_phone');
  });
  await t.test('two real booking processes with one Idempotency-Key commit one appointment/source', async () => {
    const k = key();
    const code = `const db=require('./database');db.ready.then(()=>db.transaction(c=>require('./services/bookingRequests').confirmBooking(c,require('./services/studiofy').createStudio(c),${a.id},${JSON.stringify(body())},'${k}'))).then(()=>db.close()).catch(e=>{console.error(e);process.exitCode=1});`;
    await Promise.all([runChild(code), runChild(code)]); await materializeBookingConfirmations(db);
    assert.equal((await db.getAsync('SELECT count(*)::int n FROM agendamentos')).n, 1);
    assert.equal((await db.getAsync('SELECT count(*)::int n FROM public_booking_access WHERE confirmation_snapshot IS NOT NULL')).n, 1);
    assert.equal((await db.getAsync('SELECT count(*)::int n FROM whatsapp_messages')).n, 1);
  });
  await t.test('restarted process never retries an uncertain booking confirmation', async () => {
    const row = await booking(); await webhook.drain(async () => { throw Error('Synthetic unknown'); });
    const code = "const db=require('./database');db.ready.then(()=>require('./evolutionWebhook').drain(async()=>{process.send('unexpected');return {key:{id:'synthetic'},status:'PENDING'}})).then(()=>db.close()).catch(e=>{console.error(e);process.exitCode=1});";
    let calls = 0; await runChild(code, () => { calls++; }); assert.equal(calls, 0);
    assert.equal((await message(row.id)).status, 'uncertain'); await assertBooking(row.id);
  });
  await t.test('two real processes materialize and dispatch one confirmation', async () => {
    const row = await booking(); let calls = 0;
    const code = "const db=require('./database');db.ready.then(()=>require('./evolutionWebhook').drain(async()=>{process.send('sent');return {key:{id:'synthetic'},status:'PENDING'}})).then(()=>db.close()).catch(e=>{console.error(e);process.exitCode=1});";
    await Promise.all([runChild(code, () => { calls++; }), runChild(code, () => { calls++; })]);
    assert.equal(calls, 1); assert.equal((await message(row.id)).status, 'sent'); await assertBooking(row.id);
    await runChild(code, () => assert.fail('restart cannot resend')); assert.equal((await db.getAsync('SELECT count(*)::int n FROM whatsapp_messages')).n, 1);
  });
  await t.test('real crash AFTER COMMIT and BEFORE materialization: restarted processes recover one source', async () => {
    const code = `const db=require('./database');db.ready.then(()=>db.transaction(c=>require('./services/bookingRequests').confirmBooking(c,require('./services/studiofy').createStudio(c),${a.id},${JSON.stringify(body())},'${key()}'))).then(async()=>{const row=await db.getAsync('SELECT id FROM agendamentos ORDER BY id DESC LIMIT 1');process.send(row.id);setInterval(()=>{},1000)}).catch(e=>{console.error(e);process.exitCode=1});`;
    const child = spawn(process.execPath, ['-e', code], { cwd: path.join(__dirname, '..'), env: process.env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    const exited = new Promise(resolve => child.once('exit', resolve)); let errors = ''; child.stderr.on('data', chunk => { errors += chunk; });
    let id;
    try {
      id = await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('Commit barrier not reached: ' + errors)), 15000); child.once('message', value => { clearTimeout(timer); resolve(value); }); child.once('error', reject); child.once('exit', () => { clearTimeout(timer); reject(Error(errors)); }); });
      assert.ok((await origin(id)).confirmation_snapshot); assert.equal(await message(id), undefined); child.kill(); await exited;
    } finally { if (child.exitCode === null) { child.kill(); await exited; } }
    const recover = "const db=require('./database');db.ready.then(()=>require('./services/bookingConfirmation').materializeBookingConfirmations(db)).then(()=>db.close()).catch(e=>{console.error(e);process.exitCode=1});";
    await Promise.all([runChild(recover), runChild(recover)]); assert.ok(await message(id)); assert.equal((await db.getAsync('SELECT count(*)::int n FROM whatsapp_messages')).n, 1);
    let calls = 0; await webhook.drain(async () => { calls++; return accepted(); }); await webhook.drain(() => assert.fail()); assert.equal(calls, 1); await assertBooking(id);
  });
});
