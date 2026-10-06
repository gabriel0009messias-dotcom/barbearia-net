const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { accountView, ACCOUNT_FIELDS } = require('../services/accountView');

test('allowlist da conta também remove campos internos de objetos aninhados', () => {
  const secret = 'synthetic-private-value';
  const view = accountView({ id: 1, barbearia_nome: 'Studio A', senha_hash: secret,
    senha_salt: secret, whatsapp_bridge_token: secret, new_internal_field: secret,
    acesso: { liberado: true, status: 'trial_active', secret,
      trial: { status: 'active', endsAt: '2026-10-15T12:00:00Z', daysRemaining: 4, token: secret } },
    lembrete_pagamento: { mensagem: 'Aviso público', credencial: secret },
    servicos: [{ id: 2, nome: 'Corte', preco: 30, assinatura_id: 1, secret }], pix: { secret },
  });
  assert.ok(!JSON.stringify(view).includes(secret));
  assert.equal(view.acesso.trial.daysRemaining, 4);
  assert.deepEqual(view.servicos, [{ id: 2, nome: 'Corte', preco: 30 }]);
  assert.deepEqual(view.lembrete_pagamento, { mensagem: 'Aviso público' });
  assert.equal(view.pix, null);
});

test('/barbeiro/me: contrato público, cache e isolamento entre estabelecimentos', async t => {
  const env = require('./helpers/postgres').testEnvironment();
  Object.assign(process.env, { MERCADO_PAGO_ACCESS_TOKEN: '', MERCADO_PAGO_WEBHOOK_SECRET: '',
    EVOLUTION_API_URL: '', EVOLUTION_API_KEY: '' });
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
  const api = async (route, token, body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api${route}`, {
      method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json',
        ...(token ? { 'x-barbeiro-token': token } : {}) }, body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json(), cache: response.headers.get('cache-control') };
  };
  const owners = [];
  for (let n = 0; n < 2; n++) {
    const email = `dashboard-${n}@example.test`;
    const signup = await api('/publico/assinaturas', null, {
      barbeariaNome: `Dashboard ${n}`, responsavelNome: 'Titular', telefone: `1199999700${n}`,
      email, senha: 'synthetic-password', metodoPagamento: 'mercado_pago', diaVencimento: 5,
      servicos: [{ nome: `Serviço ${n}`, preco: 30.1 }],
    });
    assert.equal(signup.status, 201);
    const id = signup.body.assinatura.id;
    await db.runAsync('UPDATE assinaturas SET whatsapp_bridge_token=$1 WHERE id=$2', [`synthetic-bridge-${n}`, id]);
    const login = await api('/barbeiro/login', null, { identificador: email, senha: 'synthetic-password' });
    assert.equal(login.status, 200);
    owners.push({ id, token: login.body.token });
  }
  for (let n = 0; n < owners.length; n++) {
    const result = await api(`/barbeiro/me?assinatura_id=${owners[1-n].id}`, owners[n].token);
    assert.equal(result.status, 200);
    assert.equal(result.cache, 'no-store');
    assert.equal(result.body.id, owners[n].id);
    assert.equal(result.body.barbearia_nome, `Dashboard ${n}`);
    assert.deepEqual(Object.keys(result.body).sort(), [...ACCOUNT_FIELDS, 'acesso', 'pix', 'lembrete_pagamento', 'servicos'].sort());
    assert.equal(result.body.acesso.liberado, true);
    assert.equal(result.body.acesso.status, 'trial_active');
    assert.ok(result.body.acesso.trial.daysRemaining > 0);
    assert.ok(Array.isArray(result.body.dias_funcionamento));
    assert.equal(result.body.servicos[0].nome, `Serviço ${n}`);
    assert.doesNotMatch(JSON.stringify(result.body), /senha_hash|senha_salt|whatsapp_bridge_token|synthetic-bridge/);
    const panel = await api('/studiofy/painel', owners[n].token);
    assert.equal(panel.status, 200);
    assert.ok(panel.body.servicos.every(service => service.assinatura_id === owners[n].id));
    assert.equal(panel.body.financeiro.total.valor_centavos, 0);
  }
  for (const token of [undefined, 'forged']) {
    const rejected = await api('/barbeiro/me', token);
    assert.equal(rejected.status, 401);
    assert.equal(rejected.cache, 'no-store');
  }
  await t.test('indicadores financeiros e serviços usam somente dados da conta logada', async () => {
    const today = require('../services/agenda').localMoment().date;
    const insert = (owner, name, price, status = 'concluido', date = today) => db.runAsync(
      `INSERT INTO agendamentos (assinatura_id,nome_cliente,telefone,servico_nome,preco,data,hora,status)
       VALUES ($1,$2,'11999995555',$3,$4,$5,'00:00',$6)`,
      [owner.id, name, `Serviço da conta ${owner.id}`, price, date, status]);
    await insert(owners[0], 'Atendido A', 10.1);
    await insert(owners[0], 'Atendido A novamente', 20.2);
    await insert(owners[0], 'Cancelado A', 999, 'cancelado');
    await insert(owners[0], 'Falta A', 999, 'falta');
    await insert(owners[0], 'Futuro A', 999, 'concluido', '2099-01-01');
    await insert(owners[1], 'Cliente exclusivo B', 1000);
    const a = await api('/studiofy/painel', owners[0].token);
    const b = await api('/studiofy/painel', owners[1].token);
    for (const period of ['hoje', 'semana', 'mes', 'total']) {
      assert.equal(a.body.financeiro[period].valor_centavos, 3030);
      assert.equal(a.body.financeiro[period].atendimentos, 2);
      assert.equal(b.body.financeiro[period].valor_centavos, 100000);
    }
    assert.equal(a.body.financeiro.servicos[0].atendimentos, 2);
    assert.ok(a.body.agendamentos.every(booking => booking.assinatura_id === owners[0].id));
    assert.ok(!JSON.stringify(a.body).includes('Cliente exclusivo B'));
    assert.ok(!JSON.stringify(b.body).includes('Atendido A'));
  });
});
