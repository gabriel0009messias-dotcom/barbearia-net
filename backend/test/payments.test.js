const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const express = require('express');

test('Mercado Pago: cadastro, checkout e confirmacao pelo backend', async t => {
  const testDb = require('./helpers/postgres').testEnvironment();
  process.env.MERCADO_PAGO_ACCESS_TOKEN = 'fake-test-token';
  process.env.MERCADO_PAGO_WEBHOOK_SECRET = 'fake-webhook-secret';
  process.env.MERCADO_PAGO_MODE = 'test';
  process.env.PUBLIC_APP_URL = 'https://example.test';
  process.env.LEGACY_ADMIN_EMAIL = 'admin@example.test';
  process.env.LEGACY_ADMIN_PASSWORD = 'fake-admin-password';
  const db = require('../database');
  await db.ready;
  const payments = require('../services/payments/mercadoPago');
  const app = express();
  app.use(express.json());
  app.use('/api', require('../routes'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const nativeFetch = global.fetch;
  let preference;
  let remotePayment;
  let failRemote = false;
  let calls = 0;
  global.fetch = async (url, options) => {
    if (!String(url).startsWith('https://api.mercadopago.com/')) return nativeFetch(url, options);
    calls++;
    assert.equal(options.headers.Authorization, 'Bearer fake-test-token');
    if (failRemote) return new Response('{}', { status: 503 });
    if (String(url).includes('/checkout/preferences/')) {
      assert.equal(options.method, 'GET');
      return Response.json({ ...preference, collector_id: 777, payer: { email: 'buyer@example.test' } });
    }
    if (String(url).endsWith('/users/me')) {
      assert.equal(options.method, 'GET');
      return Response.json({ id: 777, email: 'buyer@example.test', tags: ['test_user'], site_id: 'MLB', status: { mercadopago_tc_accepted: true } });
    }
    if (String(url).endsWith('/v1/payment_methods')) {
      assert.equal(options.method, 'GET');
      return Response.json([{ id: 'pix', status: 'active', payment_type_id: 'bank_transfer' }]);
    }
    if (String(url).endsWith('/checkout/preferences')) {
      preference = JSON.parse(options.body);
      return Response.json({ id: crypto.randomUUID(), init_point: 'https://www.mercadopago.com.br/checkout/v1/redirect?prod=1', sandbox_init_point: 'https://sandbox.mercadopago.com.br/checkout/v1/redirect?test=1' });
    }
    assert.match(String(url), /\/v1\/payments\/\d+$/);
    return Response.json(remotePayment);
  };
  t.after(async () => {
    global.fetch = nativeFetch;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => db.close(resolve));
    await testDb.cleanup();
  });
  const post = (url, body, headers = {}) => nativeFetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const signup = { barbeariaNome: 'Teste MP', responsavelNome: 'Teste', telefone: '11999998888', email: 'buyer@example.test', senha: 'test-password', metodoPagamento: 'mercado_pago', diaVencimento: 5, servicos: [{ nome: 'Corte', preco: 30 }] };
  let id;
  await t.test('cadastro fica pendente, nao aceita Pix manual e nao depende de credenciais', async () => {
    process.env.MERCADO_PAGO_ACCESS_TOKEN = '';
    process.env.MERCADO_PAGO_WEBHOOK_SECRET = '';
    assert.equal((await post('/api/publico/assinaturas', { ...signup, metodoPagamento: 'pix' })).status, 400);
    const response = await post('/api/publico/assinaturas', { ...signup, valor_mensal: 50, valor_plano: 1, amountCents: 100 });
    assert.equal(response.status, 201, await response.clone().text());
    id = (await response.json()).assinatura.id;
    assert.deepEqual(await db.getAsync('SELECT valor_mensal, valor_plano FROM assinaturas WHERE id = $1', [id]), { valor_mensal: 65, valor_plano: 65 });
    assert.equal((await db.getAsync("SELECT status FROM assinaturas WHERE id = $1", [id])).status, 'pendente');
    const checkoutResponse = await post(`/api/publico/assinaturas/${id}/checkout`, { senha: signup.senha });
    assert.equal(checkoutResponse.status, 503);
    assert.match((await checkoutResponse.json()).error, /Configure as credenciais/);
    assert.equal(calls, 0);
    assert.equal((await db.getAsync('SELECT status FROM assinaturas WHERE id = $1', [id])).status, 'pendente');
    assert.equal((await post('/api/publico/assinaturas', signup)).status, 409);
    assert.equal((await db.getAsync('SELECT count(*) AS total FROM assinaturas WHERE email = $1', [signup.email])).total, 1);
    process.env.MERCADO_PAGO_ACCESS_TOKEN = 'fake-test-token';
    process.env.MERCADO_PAGO_WEBHOOK_SECRET = 'fake-webhook-secret';
  });
  await t.test('checkout autenticado, preco do banco, referencia unica e reutilizacao', async () => {
    assert.equal((await post(`/api/publico/assinaturas/${id}/checkout`, {})).status, 401);
    const response = await post(`/api/publico/assinaturas/${id}/checkout`, { senha: signup.senha, valor: 0.01 });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.match(result.checkoutUrl, /^https:\/\/sandbox.mercadopago/);
    assert.equal(preference.items[0].unit_price, 65);
    assert.equal(preference.items[0].quantity, 1);
    assert.equal(preference.items[0].currency_id, 'BRL');
    assert.deepEqual(preference.payer, { email: signup.email });
    assert.equal(preference.payment_methods, undefined);
    assert.equal(preference.auto_return, 'approved');
    assert.deepEqual(preference.back_urls, Object.fromEntries(['success', 'pending', 'failure'].map(key => [key, `https://example.test/cadastro.html?assinatura=${id}&gateway=mercado_pago`])));
    const config = await (await nativeFetch(base + '/api/publico/assinatura-config')).json();
    assert.equal(config.valorMensal, 65);
    assert.deepEqual(result.plan, config.plan);
    assert.equal(result.plan.amountCents, 6500);
    assert.equal(result.plan.durationDays, 30);
    assert.equal(preference.notification_url, 'https://example.test/api/mercadopago/webhook');
    assert.ok(preference.external_reference);
    const count = calls;
    assert.equal((await post(`/api/publico/assinaturas/${id}/checkout`, { senha: signup.senha })).status, 200);
    assert.equal(calls, count);
    assert.equal((await post('/api/barbeiro/login', { identificador: signup.email, senha: signup.senha })).status, 403);
  });
  await t.test('diagnostico exige admin, usa apenas GET e nao altera banco nem expoe segredos', async () => {
    const order = await db.getAsync('SELECT * FROM mercado_pago_orders WHERE assinatura_id=$1', [id]);
    const subscription = await db.getAsync('SELECT * FROM assinaturas WHERE id=$1', [id]);
    const endpoint = `${base}/api/admin/mercadopago/diagnostico/${order.preference_id}`;
    const count = calls;
    assert.equal((await nativeFetch(endpoint)).status, 401);
    assert.equal(calls, count);
    const login = await (await post('/api/admin/login', { email: 'admin@example.test', senha: 'fake-admin-password' })).json();
    const headers = { 'x-admin-token': login.token };
    assert.equal((await nativeFetch(`${base}/api/admin/mercadopago/diagnostico/not-found`, { headers })).status, 404);
    assert.equal(calls, count);
    const response = await nativeFetch(endpoint, { headers });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const report = await response.json();
    assert.equal(report.checks.collectorMatchesCredential, true);
    assert.equal(report.checks.payerMatchesSeller, true);
    assert.equal(report.checks.subscriptionMatchesSeller, true);
    assert.equal(report.checks.sellerIsTestUser, true);
    assert.equal(report.checks.referenceMatches, true);
    assert.equal(report.webhookConfigured, true);
    assert.equal(report.preference.body.payer.email, '[REDACTED]');
    assert.doesNotMatch(JSON.stringify(report), /fake-test-token|fake-webhook-secret|buyer@example/);
    assert.deepEqual(await db.getAsync('SELECT * FROM mercado_pago_orders WHERE assinatura_id=$1', [id]), order);
    assert.deepEqual(await db.getAsync('SELECT * FROM assinaturas WHERE id=$1', [id]), subscription);
  });
  const notify = (paymentId = '12345', options = {}) => {
    const ts = String(Date.now());
    const requestId = 'test-request';
    const v1 = crypto.createHmac('sha256', process.env.MERCADO_PAGO_WEBHOOK_SECRET).update(`id:${paymentId};request-id:${requestId};ts:${ts};`).digest('hex');
    return post(`/api/mercadopago/webhook?data.id=${paymentId}&type=payment`, { type: 'payment', data: { id: paymentId }, ...options.body }, {
      'x-request-id': requestId, 'x-signature': `ts=${ts},v1=${v1}`, ...options.headers,
    });
  };
  const approved = () => ({ id: 12345, status: 'approved', currency_id: 'BRL', transaction_amount: 65, live_mode: false, external_reference: preference.external_reference, date_approved: new Date().toISOString() });
  await t.test('assinatura invalida e ID adulterado sao rejeitados antes de consultar API', async () => {
    const count = calls;
    assert.equal((await notify('12345', { headers: { 'x-signature': 'invalid' } })).status, 401);
    assert.equal((await notify('12345', { body: { data: { id: '98765' } } })).status, 400);
    assert.equal(calls, count);
  });
  await t.test('pendente nao ativa; falha da API retorna erro para permitir nova tentativa', async () => {
    remotePayment = { ...approved(), status: 'pending' };
    assert.equal((await notify()).status, 200);
    assert.equal((await db.getAsync("SELECT status FROM assinaturas WHERE id = $1", [id])).status, 'pendente');
    failRemote = true;
    assert.equal((await notify()).status, 503);
    failRemote = false;
  });
  await t.test('admin consulta pagamento; frontend nao pode ativar por PATCH', async () => {
    const login = await (await post('/api/admin/login', { email: 'admin@example.test', senha: 'fake-admin-password' })).json();
    const headers = { 'Content-Type': 'application/json', 'x-admin-token': login.token };
    const config = await nativeFetch(`${base}/api/admin/assinatura-config`, { headers });
    assert.equal(config.status, 200);
    assert.equal((await config.json()).gateway.provider, 'mercado_pago');
    const patch = await nativeFetch(`${base}/api/admin/assinaturas/${id}`, { method: 'PATCH', headers, body: JSON.stringify({ status: 'ativo' }) });
    assert.equal(patch.status, 400);
    remotePayment = { ...approved(), status: 'pending' };
    const response = await post(`/api/admin/assinaturas/${id}/confirmar-pagamento`, { paymentId: '12345' }, headers);
    assert.equal(response.status, 409);
  });
  await t.test('valor, moeda, ambiente e cliente incorretos nao ativam', async () => {
    for (const change of [{ transaction_amount: 1 }, { currency_id: 'USD' }, { live_mode: true }]) {
      remotePayment = { ...approved(), ...change };
      assert.equal((await notify()).status, 422);
    }
    remotePayment = approved();
    await assert.rejects(payments.reconcile('12345', id + 1), { statusCode: 422 });
    remotePayment = { ...approved(), external_reference: 'unknown-reference' };
    assert.equal((await (await notify()).json()).ignored, true);
  });
  await t.test('aprovado ativa e notificacoes duplicadas concorrentes nao estendem acesso', async () => {
    remotePayment = approved();
    const responses = await Promise.all([notify(), notify(), notify()]);
    assert.deepEqual(responses.map(r => r.status), [200, 200, 200]);
    const subscription = await db.getAsync("SELECT * FROM assinaturas WHERE id = $1", [id]);
    assert.equal(subscription.status, 'ativo');
    assert.equal(subscription.status_assinatura, 'ATIVA');
    assert.equal(subscription.bloqueado, 0);
    assert.equal(subscription.payment_id, '12345');
    const due = subscription.proximo_vencimento;
    await notify();
    assert.equal((await db.getAsync("SELECT proximo_vencimento FROM assinaturas WHERE id = $1", [id])).proximo_vencimento, due);
    assert.equal((await db.getAsync('SELECT count(*) AS total FROM mercado_pago_payments WHERE credited_at IS NOT NULL')).total, 1);
    const login = await post('/api/barbeiro/login', { identificador: signup.email, senha: signup.senha });
    assert.equal(login.status, 200);
    const token = (await login.json()).token;
    for (const route of ['/barbeiro/me', '/agendamentos', '/bloqueios', '/faturamento?periodo=dia', '/faturamento?periodo=mes', '/faturamento?periodo=ano']) {
      const response = await nativeFetch(base + '/api' + route, { headers: { 'x-barbeiro-token': token } });
      assert.equal(response.status, 200, await response.clone().text());
    }
  });
  await t.test('rejeitado antigo nao bloqueia; estorno do pagamento atual bloqueia', async () => {
    remotePayment = { ...approved(), id: 98765, status: 'rejected' };
    await notify('98765');
    assert.equal((await db.getAsync("SELECT bloqueado FROM assinaturas WHERE id = $1", [id])).bloqueado, 0);
    remotePayment = { ...approved(), status: 'refunded' };
    await notify();
    assert.equal((await db.getAsync("SELECT bloqueado FROM assinaturas WHERE id = $1", [id])).bloqueado, 1);
  });
  await t.test('sem segredo ou token falha com erro controlado', async () => {
    process.env.MERCADO_PAGO_ACCESS_TOKEN = '';
    await assert.rejects(payments.reconcile('12345'), { statusCode: 503 });
    process.env.MERCADO_PAGO_ACCESS_TOKEN = 'fake-test-token';
    process.env.MERCADO_PAGO_WEBHOOK_SECRET = '';
    assert.equal((await post('/api/mercadopago/webhook?data.id=12345', {})).status, 503);
  });
});
