const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');

test('listagem administrativa exige pagamento aprovado ou liberacao manual', async t => {
  const env = require('./helpers/postgres').testEnvironment();
  process.env.LEGACY_ADMIN_EMAIL = 'admin@example.test';
  process.env.LEGACY_ADMIN_PASSWORD = 'fake-admin-password';
  process.env.MERCADO_PAGO_ACCESS_TOKEN = 'fake-list-token';
  process.env.MERCADO_PAGO_WEBHOOK_SECRET = 'fake-list-secret';
  process.env.MERCADO_PAGO_MODE = 'test';
  process.env.PUBLIC_APP_URL = 'https://example.test';
  const db = require('../database');
  await db.ready;
  const app = express();
  app.use(express.json());
  app.use('/api', require('../routes'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await db.close();
    await env.cleanup();
  });
  const nativeFetch = global.fetch;
  let preference;
  let payment;
  t.mock.method(global, 'fetch', async (url, options) => {
    assert.ok(String(url).startsWith('https://api.mercadopago.com/'));
    if (String(url).endsWith('/users/me')) return Response.json({ email: 'seller@example.test' });
    if (String(url).endsWith('/checkout/preferences')) {
      preference = JSON.parse(options.body);
      return Response.json({ id: 'test-preference', sandbox_init_point: 'https://sandbox.mercadopago.com.br/test-checkout' });
    }
    assert.match(String(url), /\/v1\/payments\/\d+$/);
    return Response.json(payment);
  });
  const request = (route, method = 'GET', body, headers = {}) => nativeFetch(`http://127.0.0.1:${server.address().port}/api${route}`, {
    method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined,
  });
  const adminLogin = await request('/admin/login', 'POST', { email: 'admin@example.test', senha: 'fake-admin-password' });
  const admin = { 'x-admin-token': (await adminLogin.json()).token };
  const list = async () => {
    const response = await request('/admin/assinaturas', 'GET', undefined, admin);
    assert.equal(response.status, 200);
    return response.json();
  };
  const ids = [];
  for (const n of [1, 2, 3, 4]) {
    const response = await request('/publico/assinaturas', 'POST', {
      barbeariaNome: `Salao ${n}`, responsavelNome: 'Teste', telefone: `list${n}`, email: `list${n}@example.test`,
      senha: 'test-password', metodoPagamento: 'mercado_pago', diaVencimento: 5, servicos: [{ nome: 'Corte', preco: 30 }],
    });
    assert.equal(response.status, 201);
    ids.push((await response.json()).assinatura.id);
  }
  const snapshot = () => db.allAsync('SELECT * FROM assinaturas ORDER BY id');
  await t.test('cadastro sem pagamento e simples status ativo ficam ocultos sem apagar ou alterar dados', async () => {
    await db.runAsync("UPDATE assinaturas SET status='ativo',status_assinatura='ATIVA',proximo_vencimento='2099-01-01' WHERE id=$1", [ids[3]]);
    await db.runAsync(`INSERT INTO mercado_pago_orders(reference,assinatura_id,amount_cents,live_mode,expires_at)
      VALUES ('uncredited-order',$1,6500,0,'2099-01-01')`, [ids[3]]);
    await db.runAsync(`INSERT INTO mercado_pago_payments(payment_id,order_reference,assinatura_id,status,amount_cents)
      VALUES ('uncredited-payment','uncredited-order',$1,'approved',6500)`, [ids[3]]);
    const before = await snapshot();
    assert.deepEqual(await list(), []);
    assert.deepEqual(await snapshot(), before);
    assert.equal((await request('/admin/assinaturas')).status, 401);
  });
  await t.test('pedido e checkout criados nao sao pagamento aprovado', async () => {
    const checkout = await request(`/publico/assinaturas/${ids[0]}/checkout`, 'POST', { senha: 'test-password' });
    assert.equal(checkout.status, 200);
    assert.equal((await checkout.json()).plan.amountCents, 6500);
    assert.deepEqual(await list(), []);
  });
  const notify = async status => {
    payment = { id: 12345, status, currency_id: 'BRL', transaction_amount: 65, live_mode: false,
      external_reference: preference.external_reference, date_approved: '2026-09-15T12:00:00Z' };
    const ts = String(Date.now());
    const requestId = 'listing-webhook';
    const signature = crypto.createHmac('sha256', process.env.MERCADO_PAGO_WEBHOOK_SECRET)
      .update(`id:12345;request-id:${requestId};ts:${ts};`).digest('hex');
    const response = await request('/mercadopago/webhook?data.id=12345&type=payment', 'POST', { type: 'payment', data: { id: 12345 } }, {
      'x-request-id': requestId, 'x-signature': `ts=${ts},v1=${signature}`,
    });
    assert.equal(response.status, 200);
  };
  await t.test('webhooks sem approved nao incluem cliente', async () => {
    for (const status of ['pending', 'rejected', 'cancelled', 'in_process', 'authorized', 'refunded', 'charged_back', 'unknown']) {
      await notify(status);
      const before = await snapshot();
      assert.deepEqual(await list(), [], status);
      assert.deepEqual(await snapshot(), before);
    }
  });
  await t.test('webhook approved libera 30 dias e inclui automaticamente sem duplicar', async () => {
    await notify('approved');
    assert.deepEqual((await list()).map(row => row.id), [ids[0]]);
    const row = await db.getAsync('SELECT * FROM assinaturas WHERE id=$1', [ids[0]]);
    assert.equal(row.proximo_vencimento, '2026-10-15');
    assert.equal(row.bloqueado, 0);
    await notify('approved');
    assert.deepEqual((await list()).map(row => row.id), [ids[0]]);
    assert.equal((await db.getAsync('SELECT proximo_vencimento FROM assinaturas WHERE id=$1', [ids[0]])).proximo_vencimento, row.proximo_vencimento);
  });
  await t.test('admin localiza oculto por email e libera manualmente', async () => {
    const lookup = '/admin/assinaturas/por-email?email=%20LIST2%40EXAMPLE.TEST%20';
    assert.equal((await request(lookup)).status, 401);
    const before = await snapshot();
    const found = await request(lookup, 'GET', undefined, admin);
    assert.equal(found.status, 200);
    assert.deepEqual(await found.json(), { id: ids[1], barbearia_nome: 'Salao 2', email: 'list2@example.test' });
    assert.deepEqual(await snapshot(), before);
    assert.equal((await request('/admin/assinaturas/por-email?email=list2', 'GET', undefined, admin)).status, 400);
    assert.equal((await request('/admin/assinaturas/por-email?email=missing@example.test', 'GET', undefined, admin)).status, 404);
    assert.equal((await request(`/admin/assinaturas/${ids[1]}/liberar-dias`, 'POST', { dias: 1 }, admin)).status, 200);
    assert.deepEqual((await list()).map(row => row.id).sort(), ids.slice(0, 2).sort());
    assert.equal((await db.getAsync('SELECT count(*) AS total FROM mercado_pago_payments WHERE assinatura_id=$1', [ids[1]])).total, 0);
    // Retain the manually admitted customer for management even after their free period ends.
    await db.runAsync("UPDATE assinaturas SET acesso_manual_ate='2000-01-01T00:00:00Z' WHERE id=$1", [ids[1]]);
    assert.ok((await list()).some(row => row.id === ids[1]));
  });
  await t.test('cliente pago ativo legado continua visivel sem depender so do status', async () => {
    await db.runAsync(`UPDATE assinaturas SET status='ativa', status_assinatura='ATIVA', gateway_status='approved',
      payment_id='legacy-payment', ultimo_pagamento='2026-09-15', proximo_vencimento='2099-01-01' WHERE id=$1`, [ids[2]]);
    const visible = (await list()).map(row => row.id);
    assert.ok(visible.includes(ids[0]));
    assert.ok(visible.includes(ids[2]));
    assert.ok(!visible.includes(ids[3]));
  });
  await t.test('renovacao pendente nao oculta quem ja tem pagamento aprovado', async () => {
    for (const id of [ids[0], ids[2]]) {
      await db.runAsync(`INSERT INTO mercado_pago_orders(reference,assinatura_id,amount_cents,live_mode,expires_at)
        VALUES ($1,$2,6500,0,'2099-01-01')`, [`renewal-${id}`, id]);
      await db.runAsync(`INSERT INTO mercado_pago_payments(payment_id,order_reference,assinatura_id,status,amount_cents)
        VALUES ($1,$2,$3,'pending',6500)`, [`renewal-payment-${id}`, `renewal-${id}`, id]);
    }
    const visible = (await list()).map(row => row.id);
    assert.ok(visible.includes(ids[0]));
    assert.ok(visible.includes(ids[2]));
  });
});
