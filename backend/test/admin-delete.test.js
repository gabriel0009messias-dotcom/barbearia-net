const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

test('exclusao administrativa isolada e atomica', async t => {
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
  assert.equal(login.status, 200);
  const admin = { 'x-admin-token': (await login.json()).token };
  const ids = [];
  for (const n of [1, 2]) {
    const response = await request('/publico/assinaturas', 'POST', {
      barbeariaNome: `Salao ${n}`, responsavelNome: 'Teste', telefone: `1199999000${n}`, email: `owner${n}@example.test`,
      senha: 'test-password', metodoPagamento: 'mercado_pago', diaVencimento: 5, servicos: [{ nome: 'Corte', preco: 30 }],
    });
    assert.equal(response.status, 201);
    const id = (await response.json()).assinatura.id;
    ids.push(id);
    await db.runAsync("UPDATE assinaturas SET status='ativo',status_assinatura='ATIVA',bloqueado=0,proximo_vencimento='2099-01-01',data_vencimento='2099-01-01' WHERE id=$1", [id]);
    await db.runAsync("INSERT INTO agendamentos(assinatura_id,nome_cliente) VALUES ($1,'Teste')", [id]);
    await db.runAsync("INSERT INTO bloqueios(assinatura_id,data) VALUES ($1,'2099-01-01')", [id]);
    await db.runAsync("INSERT INTO sessoes(assinatura_id,telefone,etapa) VALUES ($1,'test','inicio')", [id]);
    await db.runAsync("INSERT INTO password_reset_tokens(assinatura_id,token_hash,expires_at) VALUES ($1,'fake-hash','2099-01-01')", [id]);
    await db.runAsync("INSERT INTO whatsapp_messages(assinatura_id,instance,phone,message_id,response) VALUES ($1,$2,'test','message','test')", [id, `instance${id}`]);
    await db.runAsync("INSERT INTO mercado_pago_orders(reference,assinatura_id,amount_cents,live_mode,expires_at) VALUES ($1,$2,6500,0,'2099-01-01')", [`order${id}`, id]);
    await db.runAsync("INSERT INTO mercado_pago_payments(payment_id,order_reference,assinatura_id,status,amount_cents,credited_at) VALUES ($1,$2,$3,'approved',6500,CURRENT_TIMESTAMP)", [`payment${id}`, `order${id}`, id]);
  }
  const barberResponse = await request('/barbeiro/login', 'POST', { identificador: 'owner2@example.test', senha: 'test-password' });
  assert.equal(barberResponse.status, 200);
  const barberToken = (await barberResponse.json()).token;
  const deletedOwnerLogin = await request('/barbeiro/login', 'POST', { identificador: 'owner1@example.test', senha: 'test-password' });
  assert.equal(deletedOwnerLogin.status, 200);
  const deletedOwnerToken = (await deletedOwnerLogin.json()).token;
  const list = await (await request('/admin/assinaturas', 'GET', undefined, admin)).json();
  const confirmationToken = list.find(row => row.id === ids[0]).deleteConfirmationToken;
  const tables = ['assinaturas', 'servicos_assinatura', 'agendamentos', 'bloqueios', 'sessoes', 'password_reset_tokens', 'whatsapp_messages', 'mercado_pago_orders', 'mercado_pago_payments'];
  const snapshot = async id => Promise.all(tables.map(table => db.allAsync(`SELECT * FROM ${table} WHERE ${table === 'assinaturas' ? 'id' : 'assinatura_id'}=$1`, [id])));
  const before = await snapshot(ids[0]);
  const other = await snapshot(ids[1]);
  const globalServices = await db.allAsync('SELECT * FROM servicos ORDER BY id');
  await db.runAsync("INSERT INTO clientes(nome,telefone) VALUES ('Cliente compartilhado','test')");
  const globalClients = await db.allAsync('SELECT * FROM clientes ORDER BY id');
  await t.test('sem login, token forjado e token de barbeiro nao excluem nenhuma conta', async () => {
    for (const headers of [{}, { 'x-admin-token': 'forged' }, { 'x-barbeiro-token': barberToken }, { 'x-admin-token': barberToken }]) {
      assert.equal((await request(`/admin/assinaturas/${ids[0]}`, 'DELETE', { confirmationToken }, headers)).status, 401);
    }
    assert.deepEqual(await snapshot(ids[0]), before);
  });
  await t.test('ID inexistente ou invalido e troca do ID selecionado sao rejeitados', async () => {
    assert.equal((await request('/admin/assinaturas/99999999', 'DELETE', { confirmationToken }, admin)).status, 404);
    for (const id of ['1abc', '0', '-1', '9007199254740992']) {
      assert.equal((await request(`/admin/assinaturas/${id}`, 'DELETE', { confirmationToken }, admin)).status, 400);
    }
    assert.equal((await request(`/admin/assinaturas/${ids[1]}`, 'DELETE', { confirmationToken }, admin)).status, 409);
    assert.equal((await request(`/admin/assinaturas/${ids[0]}`, 'DELETE', {}, admin)).status, 409);
    assert.deepEqual(await snapshot(ids[1]), other);
    const anotherLogin = await request('/admin/login', 'POST', { email: 'admin@example.test', senha: 'fake-admin-password' });
    const anotherAdmin = { 'x-admin-token': (await anotherLogin.json()).token };
    assert.equal((await request(`/admin/assinaturas/${ids[0]}`, 'DELETE', { confirmationToken }, anotherAdmin)).status, 409);
  });
  await t.test('erro no banco desfaz TODAS as exclusoes e nao expoe detalhes', async () => {
    await db.pool.query("CREATE FUNCTION reject_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private database detail'; END $$");
    await db.pool.query('CREATE TRIGGER reject_delete BEFORE DELETE ON assinaturas FOR EACH ROW EXECUTE FUNCTION reject_delete()');
    const response = await request(`/admin/assinaturas/${ids[0]}`, 'DELETE', { confirmationToken }, admin);
    assert.equal(response.status, 500);
    assert.doesNotMatch(await response.text(), /private database detail/);
    assert.deepEqual(await snapshot(ids[0]), before);
    await db.pool.query('DROP TRIGGER reject_delete ON assinaturas');
  });
  await t.test('admin exclui somente a conta confirmada e todos os dados relacionados', async () => {
    const response = await request(`/admin/assinaturas/${ids[0]}`, 'DELETE', { confirmationToken }, admin);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { sucesso: true, id: ids[0] });
    assert.deepEqual(await snapshot(ids[0]), tables.map(() => []));
    assert.deepEqual(await snapshot(ids[1]), other);
    assert.deepEqual(await db.allAsync('SELECT * FROM servicos ORDER BY id'), globalServices);
    assert.deepEqual(await db.allAsync('SELECT * FROM clientes ORDER BY id'), globalClients);
    assert.equal((await request('/barbeiro/me', 'GET', undefined, { 'x-barbeiro-token': deletedOwnerToken })).status, 401);
    assert.equal((await request(`/admin/assinaturas/${ids[0]}`, 'DELETE', { confirmationToken }, admin)).status, 404);
  });
  await t.test('tabelas anteriormente sem FK rejeitam gravacoes orfas apos exclusao', async () => {
    for (const table of ['mercado_pago_orders', 'mercado_pago_payments', 'whatsapp_messages']) {
      await assert.rejects(db.runAsync(`UPDATE ${table} SET assinatura_id=$1 WHERE assinatura_id=$2`, [ids[0], ids[1]]), { code: '23503' });
    }
    assert.deepEqual(await snapshot(ids[1]), other);
  });
});
