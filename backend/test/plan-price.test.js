const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const { testEnvironment } = require('./helpers/postgres');
const { connectionConfig } = require('../database/config');
const { migrate } = require('../database/migrate');

test('preco do plano: migration protege contratos e historico', async t => {
  const environment = testEnvironment();
  const pool = new Pool(connectionConfig());
  t.after(async () => { await pool.end(); await environment.cleanup(); });
  // Build the real schema as it existed before migration 002.
  await pool.query(`CREATE SCHEMA "${environment.schema}"`);
  const original = fs.readFileSync(path.join(__dirname, '../database/migrations/001_current_backend.sql'), 'utf8');
  await pool.query(original);
  await pool.query('CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ DEFAULT NOW())');
  await pool.query('INSERT INTO schema_migrations(name, checksum) VALUES ($1, $2)', ['001_current_backend.sql', crypto.createHash('sha256').update(original).digest('hex')]);

  async function subscription(id, extra = {}) {
    const row = { id, barbearia_nome: `Plano ${id}`, responsavel_nome: 'Teste', telefone: `1199999${id}`, email: `price${id}@example.test`, metodo_pagamento: 'mercado_pago', dia_vencimento: 5, suporte_numero: '', valor_mensal: 50, valor_plano: 65, ...extra };
    const keys = Object.keys(row);
    await pool.query(`INSERT INTO assinaturas (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')})`, Object.values(row));
  }
  await subscription(1, { gateway_checkout_url: 'https://www.mercadopago.com.br/old', gateway_external_reference: 'old-pending' });
  await subscription(2); // Payment history alone must protect this pending-looking row.
  await subscription(3, { status: 'ativo', status_assinatura: 'ATIVA' });
  await subscription(4, { observacoes: 'Contrato com valor especial' });
  await subscription(5, { plano: 'Outro plano' });
  await subscription(6, { mercado_preapproval_id: 'recurring-contract' });
  await subscription(7, { payment_id: 'historical-payment-id' });
  await subscription(8); // A credited order is sufficient payment evidence.
  await subscription(9, { valor_mensal: 55 });
  await subscription(10, { valor_plano: 50 });
  await subscription(11, { gateway_status: 'approved' });
  await subscription(12, { ultimo_pagamento: '2026-01-01' });
  await subscription(13, { valor_mensal: 65, gateway_external_reference: 'old-65', gateway_checkout_url: 'https://www.mercadopago.com.br/old-65' });
  await pool.query(`INSERT INTO mercado_pago_orders
    (reference, assinatura_id, amount_cents, live_mode, expires_at, preference_id, checkout_url, credited_payment_id)
    VALUES ('old-pending', 1, 5000, 0, '2099-01-01', 'old-pref', 'https://www.mercadopago.com.br/old', NULL),
      ('paid', 2, 5000, 0, '2099-01-01', 'paid-pref', 'https://www.mercadopago.com.br/paid', '123'),
      ('credited', 8, 5000, 0, '2099-01-01', 'credited-pref', NULL, '456'),
      ('old-65', 13, 5000, 0, '2099-01-01', 'old-65-pref', 'https://www.mercadopago.com.br/old-65', NULL)`);
  await pool.query(`INSERT INTO mercado_pago_payments (payment_id, order_reference, assinatura_id, status, amount_cents, credited_at)
    VALUES ('123', 'paid', 2, 'approved', 5000, '2026-01-01'),
      ('789', 'old-pending', 1, 'pending', 5000, NULL)`);
  const protectedIds = [2, 3, 4, 5, 6, 7, 8, 9, 11, 12];
  const protectedRows = (await pool.query('SELECT * FROM assinaturas WHERE id = ANY($1) ORDER BY id', [protectedIds])).rows;
  const history = (await pool.query('SELECT * FROM mercado_pago_payments ORDER BY payment_id')).rows;
  const paidOrder = (await pool.query("SELECT * FROM mercado_pago_orders WHERE reference = 'paid'")).rows[0];
  await subscription(14);
  await subscription(15); // Expired externally-issued preference still has payment risk.
  await subscription(16, { gateway_external_reference: 'possibly-issued' });
  await subscription(17); // Order inserted before a request: outcome may be unknown.
  await subscription(18, { mercado_last_payload: '{}' });
  await pool.query(`INSERT INTO mercado_pago_orders
    (reference, assinatura_id, amount_cents, live_mode, expires_at, preference_id, checkout_url)
    VALUES ('expired',15,5000,0,'2000-01-01','expired-pref','https://www.mercadopago.com.br/expired'),
      ('intent-only',17,5000,0,'2099-01-01',NULL,NULL)`);
  const riskyIds = [1, 13, 15, 16, 17, 18];
  const riskyRows = (await pool.query('SELECT * FROM assinaturas WHERE id = ANY($1) ORDER BY id', [riskyIds])).rows;
  const allOrders = (await pool.query('SELECT * FROM mercado_pago_orders ORDER BY reference')).rows;
  const migrationSql = fs.readFileSync(path.join(__dirname, '../database/migrations/002_professional_plan_price.sql'), 'utf8');
  await pool.query(migrationSql); // First direct execution, without the migration runner.

  await t.test('somente pendentes elegiveis recebem 65 nos dois campos e defaults novos', async () => {
    for (const id of [10, 14]) {
      const row = (await pool.query('SELECT valor_mensal, valor_plano, gateway_checkout_url, gateway_external_reference FROM assinaturas WHERE id=$1', [id])).rows[0];
      assert.deepEqual(row, { valor_mensal: 65, valor_plano: 65, gateway_checkout_url: null, gateway_external_reference: null });
    }
    await pool.query("INSERT INTO assinaturas(id,barbearia_nome,responsavel_nome,telefone,metodo_pagamento,dia_vencimento,suporte_numero) VALUES (100,'Default','Teste','default','mercado_pago',5,'')");
    assert.deepEqual((await pool.query("SELECT valor_mensal,valor_plano FROM assinaturas WHERE telefone='default'")).rows[0], { valor_mensal: 65, valor_plano: 65 });
  });
  await t.test('historico aprovado de 50 e contratos protegidos permanecem identicos', async () => {
    assert.deepEqual((await pool.query('SELECT * FROM assinaturas WHERE id = ANY($1) ORDER BY id', [protectedIds])).rows, protectedRows);
    assert.deepEqual((await pool.query('SELECT * FROM mercado_pago_payments ORDER BY payment_id')).rows, history);
    assert.deepEqual((await pool.query("SELECT * FROM mercado_pago_orders WHERE reference='paid'")).rows[0], paidOrder);
    assert.deepEqual((await pool.query('SELECT * FROM mercado_pago_payments ORDER BY payment_id')).rows, history);
  });
  await t.test('pagamento em transito, checkout expirado e pedido sem resposta ficam protegidos', async () => {
    assert.deepEqual((await pool.query('SELECT * FROM assinaturas WHERE id = ANY($1) ORDER BY id', [riskyIds])).rows, riskyRows);
    assert.deepEqual((await pool.query('SELECT * FROM mercado_pago_orders ORDER BY reference')).rows, allOrders);
  });
  await t.test('segunda execucao DIRETA nao altera registros nem limpa um novo checkout de 65', async () => {
    await pool.query(`INSERT INTO mercado_pago_orders
      (reference,assinatura_id,amount_cents,live_mode,expires_at,preference_id,checkout_url)
      VALUES ('new-65',14,6500,0,'2099-01-01','new-65-pref','https://www.mercadopago.com.br/new-65')`);
    await pool.query("UPDATE assinaturas SET gateway_external_reference='new-65', gateway_checkout_url='https://www.mercadopago.com.br/new-65' WHERE id=14");
    const snapshot = async () => ({
      subscriptions: (await pool.query('SELECT * FROM assinaturas ORDER BY id')).rows,
      orders: (await pool.query('SELECT * FROM mercado_pago_orders ORDER BY reference')).rows,
      payments: (await pool.query('SELECT * FROM mercado_pago_payments ORDER BY payment_id')).rows,
      migrations: (await pool.query('SELECT * FROM schema_migrations ORDER BY name')).rows,
    });
    const before = await snapshot();
    await pool.query(migrationSql); // Second direct execution: no schema_migrations protection.
    assert.deepEqual(await snapshot(), before);
    assert.equal((await pool.query('SELECT count(*) FROM schema_migrations')).rows[0].count, 1);
    await migrate(pool); // Only now register migration 002 through the normal runner.
  });
  await t.test('pendente antiga cria checkout de 65; contrato pago conserva 50', async () => {
    process.env.MERCADO_PAGO_ACCESS_TOKEN = 'fake-test-token';
    process.env.MERCADO_PAGO_WEBHOOK_SECRET = 'fake-test-secret';
    process.env.MERCADO_PAGO_MODE = 'test';
    process.env.PUBLIC_APP_URL = 'https://example.test';
    const db = require('../database');
    await db.ready;
    const payments = require('../services/payments/mercadoPago');
    const nativeFetch = global.fetch;
    const sent = [];
    global.fetch = async (url, options) => {
      if (String(url) === 'https://api.mercadopago.com/users/me') {
        assert.equal(options.method, 'GET');
        return Response.json({ email: 'seller@example.test' });
      }
      assert.equal(url, 'https://api.mercadopago.com/checkout/preferences');
      assert.equal(options.method, 'POST');
      sent.push(JSON.parse(options.body));
      return Response.json({ id: `new-${sent.length}`, sandbox_init_point: `https://sandbox.mercadopago.com.br/checkout/new-${sent.length}` });
    };
    try {
      const pending = (await pool.query('SELECT * FROM assinaturas WHERE id=10')).rows[0];
      pending.valor_mensal = 50; // Stale caller object must not determine the price.
      const result = await payments.checkout(pending);
      assert.equal(sent[0].items[0].unit_price, 65);
      assert.equal(result.plan.amountCents, 6500);
      assert.equal(result.plan.durationDays, 30);
      assert.notEqual(result.init_point, 'https://www.mercadopago.com.br/old');
      assert.equal((await payments.checkout(pending)).init_point, result.init_point);
      assert.equal(sent.length, 1);
      // A potentially in-flight 50 payment blocks generating a competing 65 checkout.
      await assert.rejects(payments.checkout({ id: 13 }), { statusCode: 409 });
      assert.equal(sent.length, 1);
      await payments.checkout((await pool.query('SELECT * FROM assinaturas WHERE id=2')).rows[0]);
      assert.equal(sent[1].items[0].unit_price, 50);
      assert.deepEqual((await pool.query('SELECT * FROM mercado_pago_payments ORDER BY payment_id')).rows, history);
    } finally { global.fetch = nativeFetch; }
  });
  await t.test('webhook tardio credita 50 como 50; divergencia de 50 para 65 exige revisao', async () => {
    const db = require('../database');
    const payments = require('../services/payments/mercadoPago');
    const nativeFetch = global.fetch;
    let reference = 'old-pending';
    let paymentId = '987';
    global.fetch = async url => {
      assert.equal(url, `https://api.mercadopago.com/v1/payments/${paymentId}`);
      return Response.json({ id: Number(paymentId), status: 'approved', currency_id: 'BRL', transaction_amount: 50,
        live_mode: false, external_reference: reference, date_approved: '2026-09-14T12:00:00Z' });
    };
    const notify = () => {
      const ts = String(Date.now());
      const requestId = 'late-webhook';
      const v1 = crypto.createHmac('sha256', process.env.MERCADO_PAGO_WEBHOOK_SECRET).update(`id:${paymentId};request-id:${requestId};ts:${ts};`).digest('hex');
      return payments.webhook({ query: { 'data.id': paymentId }, body: { type: 'payment', data: { id: paymentId } },
        headers: { 'x-request-id': requestId, 'x-signature': `ts=${ts},v1=${v1}` } });
    };
    try {
      assert.equal((await notify()).activated, true);
      const row = (await pool.query('SELECT * FROM assinaturas WHERE id=1')).rows[0];
      assert.equal(row.valor_mensal, 50);
      assert.equal(row.valor_plano, 50);
      assert.equal(row.proximo_vencimento, '2026-10-14');
      assert.equal((await pool.query("SELECT amount_cents FROM mercado_pago_payments WHERE payment_id='987'")).rows[0].amount_cents, 5000);
      await notify();
      assert.equal((await pool.query('SELECT proximo_vencimento FROM assinaturas WHERE id=1')).rows[0].proximo_vencimento, row.proximo_vencimento);
      reference = 'old-65'; paymentId = '988';
      const before = (await pool.query('SELECT * FROM assinaturas WHERE id=13')).rows[0];
      await assert.rejects(notify(), { statusCode: 409 });
      assert.deepEqual((await pool.query('SELECT * FROM assinaturas WHERE id=13')).rows[0], before);
      assert.equal((await pool.query("SELECT count(*) FROM mercado_pago_payments WHERE payment_id='988'")).rows[0].count, 0);
      assert.equal((await pool.query("SELECT credited_payment_id FROM mercado_pago_orders WHERE reference='old-65'")).rows[0].credited_payment_id, null);
      assert.deepEqual((await pool.query("SELECT * FROM mercado_pago_payments WHERE payment_id IN ('123','789') ORDER BY payment_id")).rows, history);
    } finally { global.fetch = nativeFetch; await db.close(); }
  });
});
