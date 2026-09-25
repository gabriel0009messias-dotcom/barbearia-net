const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

test('liberacao manual: autorizacao, prazo, pagamento preservado e revogacao', async t => {
  const env = require('./helpers/postgres').testEnvironment();
  process.env.LEGACY_ADMIN_EMAIL = 'admin@example.test';
  process.env.LEGACY_ADMIN_PASSWORD = 'fake-admin-password';
  process.env.RENDER = 'true';
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
  const request = (path, method = 'GET', body, headers = {}) => fetch(`http://127.0.0.1:${server.address().port}/api${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined,
  });
  const login = await request('/admin/login', 'POST', { email: 'admin@example.test', senha: 'fake-admin-password' });
  const admin = { 'x-admin-token': (await login.json()).token };
  const ids = [];
  for (const n of [1, 2]) {
    const response = await request('/publico/assinaturas', 'POST', {
      barbeariaNome: `Salao ${n}`, responsavelNome: 'Teste', telefone: `1199999000${n}`, email: `owner${n}@example.test`,
      senha: 'test-password', metodoPagamento: 'mercado_pago', diaVencimento: 5, servicos: [{ nome: 'Corte', preco: 30 }],
    });
    assert.equal(response.status, 201);
    ids.push((await response.json()).assinatura.id);
  }
  await db.runAsync("UPDATE assinaturas SET trial_status=NULL, trial_started_at=NULL, trial_ends_at=NULL");
  const endpoint = `/admin/assinaturas/${ids[0]}/liberar-dias`;
  const stored = id => db.getAsync('SELECT * FROM assinaturas WHERE id=$1', [id]);
  const other = await stored(ids[1]);
  const customerLogin = () => request('/barbeiro/login', 'POST', { identificador: 'owner1@example.test', senha: 'test-password' });
  assert.equal((await customerLogin()).status, 200);
  for (const headers of [{}, { 'x-admin-token': 'forged' }]) {
    assert.equal((await request(endpoint, 'POST', { dias: 1 }, headers)).status, 401);
  }
  for (const dias of [0, -1, 366, 1.5, '2', null]) {
    assert.equal((await request(endpoint, 'POST', { dias }, admin)).status, 400);
  }
  assert.equal((await request('/admin/assinaturas/999999/liberar-dias', 'POST', { dias: 1 }, admin)).status, 404);
  const before = await stored(ids[0]);
  const start = Date.now();
  const grant = await request(endpoint, 'POST', { dias: 2 }, admin);
  assert.equal(grant.status, 200);
  const until = Date.parse((await grant.json()).acesso_manual_ate);
  assert.ok(until >= start + 2 * 86400000 && until <= Date.now() + 2 * 86400000);
  const grantedLogin = await customerLogin();
  assert.equal(grantedLogin.status, 200);
  const token = (await grantedLogin.json()).token;
  assert.equal((await request(endpoint, 'POST', { dias: 1 }, { 'x-admin-token': token })).status, 401);
  const after = await stored(ids[0]);
  for (const key of ['status', 'status_assinatura', 'payment_id', 'ultimo_pagamento', 'proximo_vencimento', 'gateway_status']) {
    assert.equal(after[key], before[key], key);
  }
  assert.deepEqual(await stored(ids[1]), other);
  assert.equal((await db.getAsync('SELECT count(*) AS total FROM mercado_pago_payments')).total, 0);
  const listed = await (await request('/admin/assinaturas', 'GET', undefined, admin)).json();
  assert.equal(listed.find(row => row.id === ids[0]).status, 'ativa');
  await request(endpoint, 'POST', { dias: 1 }, admin);
  assert.equal(Date.parse((await stored(ids[0])).acesso_manual_ate), until, 'nao encurta prazo existente');
  await db.runAsync("UPDATE assinaturas SET acesso_manual_ate='2000-01-01T00:00:00.000Z' WHERE id=$1", [ids[0]]);
  assert.equal((await request('/agendamentos', 'GET', undefined, { 'x-barbeiro-token': token })).status, 403);
  assert.equal((await customerLogin()).status, 200);
  await request(endpoint, 'POST', { dias: 1 }, admin);
  assert.equal((await customerLogin()).status, 200);
  assert.equal((await request(`/admin/assinaturas/${ids[0]}`, 'PATCH', { status: 'bloqueado' }, admin)).status, 200);
  assert.equal((await stored(ids[0])).acesso_manual_ate, null);
  assert.equal((await customerLogin()).status, 200);
  await request(endpoint, 'POST', { dias: 1 }, admin);
  assert.equal((await customerLogin()).status, 200);
  await request(`/admin/assinaturas/${ids[0]}/bloquear`, 'POST', {}, admin);
  assert.equal((await customerLogin()).status, 200);
});
