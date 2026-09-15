const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

test('cadastro novo nao assume contratos existentes', async t => {
  const environment = require('./helpers/postgres').testEnvironment();
  process.env.MERCADO_PAGO_ACCESS_TOKEN = 'fake-test-token';
  process.env.MERCADO_PAGO_WEBHOOK_SECRET = 'fake-test-secret';
  process.env.MERCADO_PAGO_MODE = 'test';
  process.env.PUBLIC_APP_URL = 'https://example.test';
  const db = require('../database');
  await db.ready;
  const app = express();
  app.use(express.json());
  app.use('/api', require('../routes'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const nativeFetch = global.fetch;
  let providerCalls = 0;
  global.fetch = async (url, options) => {
    if (String(url) === 'https://api.mercadopago.com/users/me') {
      assert.equal(options.method, 'GET');
      return Response.json({ email: 'seller@example.test' });
    }
    assert.equal(String(url), 'https://api.mercadopago.com/checkout/preferences');
    providerCalls++;
    assert.equal(JSON.parse(options.body).items[0].unit_price, 65);
    return Response.json({ id: 'new-preference', sandbox_init_point: 'https://sandbox.mercadopago.com.br/new' });
  };
  t.after(async () => {
    global.fetch = nativeFetch;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => db.close(resolve));
    await environment.cleanup();
  });
  const post = (route, body) => nativeFetch(`http://127.0.0.1:${server.address().port}/api${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const old = { barbeariaNome: 'Contrato antigo', responsavelNome: 'Titular teste', telefone: '11111111111', whatsappNumero: '11222222222', email: 'old@example.test', cpfTitular: '12345678909', senha: 'test-password', metodoPagamento: 'mercado_pago', diaVencimento: 5, servicos: [{ nome: 'Corte', preco: 30 }] };
  const oldResponse = await post('/publico/assinaturas', old);
  assert.equal(oldResponse.status, 201);
  const id = (await oldResponse.json()).assinatura.id;
  await db.runAsync("UPDATE assinaturas SET valor_mensal=50, valor_plano=50 WHERE id=$1", [id]);
  await db.runAsync(`INSERT INTO mercado_pago_orders(reference,assinatura_id,amount_cents,live_mode,expires_at,preference_id,checkout_url)
    VALUES ('old-order',$1,5000,0,'2099-01-01','old-preference','https://sandbox.mercadopago.com.br/old')`, [id]);
  await db.runAsync(`INSERT INTO mercado_pago_payments(payment_id,order_reference,assinatura_id,status,amount_cents,credited_at)
    VALUES ('111','old-order',$1,'approved',5000,'2026-01-01')`, [id]);
  const fresh = { ...old, barbeariaNome: 'Cadastro inedito', telefone: '11333333333', whatsappNumero: '11444444444', email: 'new@example.test' };
  const snapshot = async () => ({
    subscription: await db.getAsync('SELECT * FROM assinaturas WHERE id=$1', [id]),
    orders: await db.allAsync('SELECT * FROM mercado_pago_orders WHERE assinatura_id=$1', [id]),
    payments: await db.allAsync('SELECT * FROM mercado_pago_payments WHERE assinatura_id=$1', [id]),
    services: await db.allAsync('SELECT * FROM servicos_assinatura WHERE assinatura_id=$1', [id]),
  });
  for (const field of ['telefone', 'whatsappNumero', 'email', 'barbeariaNome']) {
    await t.test(`coincidencia apenas em ${field} retorna 409 sem alterar contrato ou historico`, async () => {
      const before = await snapshot();
      const response = await post('/publico/assinaturas', { ...fresh, [field]: old[field] });
      assert.equal(response.status, 409);
      const payload = await response.json();
      assert.equal(payload.code, 'ASSINATURA_EXISTENTE');
      assert.equal(payload.assinatura, undefined);
      assert.deepEqual(await snapshot(), before);
      assert.equal(providerCalls, 0);
    });
  }
  await t.test('titular pode entrar e escolher explicitamente continuar checkout contratado de 50', async () => {
    const login = await post('/barbeiro/login', { identificador: old.email, senha: old.senha });
    assert.equal(login.status, 403);
    const before = await snapshot();
    const checkout = await post(`/publico/assinaturas/${id}/checkout`, { senha: old.senha });
    assert.equal(checkout.status, 200);
    const result = await checkout.json();
    assert.equal(result.plan.amountCents, 5000);
    assert.equal(result.checkoutUrl, 'https://sandbox.mercadopago.com.br/old');
    assert.equal(providerCalls, 0);
    assert.deepEqual(await snapshot(), before);
  });
  await t.test('senha incorreta e contrato legado sem senha nao permitem assumir assinatura', async () => {
    assert.equal((await post('/publico/assinaturas', { ...old, senha: 'outra-senha' })).status, 409);
    await db.runAsync("UPDATE assinaturas SET senha_hash=NULL, senha_salt=NULL WHERE id=$1", [id]);
    const before = await snapshot();
    assert.equal((await post('/publico/assinaturas', old)).status, 409);
    assert.deepEqual(await snapshot(), before);
  });
  await t.test('CPF e responsavel iguais nao colidem; cadastro inedito e checkout usam 65', async () => {
    const before = await snapshot();
    const response = await post('/publico/assinaturas', { ...fresh, valor_mensal: 50, valor_plano: 50 });
    assert.equal(response.status, 201);
    const newId = (await response.json()).assinatura.id;
    assert.notEqual(newId, id);
    assert.deepEqual(await db.getAsync('SELECT valor_mensal,valor_plano FROM assinaturas WHERE id=$1', [newId]), { valor_mensal: 65, valor_plano: 65 });
    const checkout = await post(`/publico/assinaturas/${newId}/checkout`, { senha: fresh.senha, amount_cents: 5000 });
    assert.equal(checkout.status, 200);
    const result = await checkout.json();
    assert.equal(result.plan.amountCents, 6500);
    assert.equal(result.plan.durationDays, 30);
    assert.equal(result.checkoutUrl, 'https://sandbox.mercadopago.com.br/new');
    assert.equal((await db.getAsync('SELECT amount_cents FROM mercado_pago_orders WHERE assinatura_id=$1', [newId])).amount_cents, 6500);
    assert.equal(providerCalls, 1);
    assert.deepEqual(await snapshot(), before);
  });
});
