const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { identities } = require('../services/trial');
const { avaliarAcessoAssinatura } = require('../services/access');

test('cadastro: identidades, exclusão e contratação sem novo trial', async t => {
  const environment = require('./helpers/postgres').testEnvironment();
  Object.assign(process.env, { MERCADO_PAGO_ACCESS_TOKEN: 'fixture-only',
    MERCADO_PAGO_WEBHOOK_SECRET: 'fixture-only', MERCADO_PAGO_MODE: 'test',
    PUBLIC_APP_URL: 'https://example.test', EVOLUTION_API_URL: '', EVOLUTION_API_KEY: '' });
  const db = require('../database'); await db.ready;
  const app = express(); app.use(express.json()); app.use('/api', require('../routes'));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const nativeFetch = global.fetch;
  t.mock.method(global, 'fetch', async url => {
    assert.ok(String(url).startsWith('https://api.mercadopago.com/'));
    if (String(url).endsWith('/users/me')) return Response.json({ email: 'seller@example.test' });
    assert.ok(String(url).endsWith('/checkout/preferences'));
    return Response.json({ id: 'fixture-checkout', sandbox_init_point: 'https://sandbox.mercadopago.com.br/fixture-checkout' });
  });
  t.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await db.close(); await environment.cleanup();
  });
  let sequence = 0;
  const body = extra => { const n = ++sequence; return {
    establishmentName: 'Studio Nome Compartilhado', businessType: 'other', city: 'Cidade Fictícia', state: 'SP',
    responsavelNome: 'Responsável Fictício', cpfTitular: '00000000000',
    telefone: `1198000${String(n).padStart(4, '0')}`, whatsappNumero: `1199000${String(n).padStart(4, '0')}`,
    email: `fixture-${n}@example.test`, senha: 'fixture-only-password', metodoPagamento: 'mercado_pago',
    diaVencimento: 5, servicos: [{ nome: 'Serviço Fictício', preco: 30, duracao: 30 }], ...extra,
  }; };
  const request = async (route, data) => {
    const response = await nativeFetch(`http://127.0.0.1:${server.address().port}/api${route}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
    });
    return { status: response.status, data: await response.json() };
  };
  const signup = data => request('/publico/assinaturas', data);
  const firstBody = body(), first = await signup(firstBody);
  assert.equal(first.status, 201); assert.equal(first.data.trialIniciado, true);
  const id = first.data.assinatura.id;
  await t.test('identidades novas com mesmo nome, CPF e responsável permitem cadastros isolados', async () => {
    const second = await signup(body()); assert.equal(second.status, 201);
    assert.notEqual(second.data.assinatura.id, id);
    const rows = await db.allAsync("SELECT id,COALESCE(public_slug,'studio-' || id) AS public_slug FROM assinaturas ORDER BY id");
    assert.equal(new Set(rows.map(row => row.public_slug)).size, rows.length);
    for (const row of rows) assert.ok(row.public_slug);
    assert.equal((await db.getAsync('SELECT count(*)::int AS n FROM servicos_assinatura WHERE assinatura_id=$1', [id])).n, 1);
  });
  for (const [label, change] of [
    ['email normalizado', { email: ` ${firstBody.email.toUpperCase()} ` }],
    ['telefone normalizado', { telefone: '+55 ' + firstBody.telefone }],
    ['WhatsApp normalizado', { whatsappNumero: '+55 ' + firstBody.whatsappNumero }],
    ['telefone contra WhatsApp', { telefone: firstBody.whatsappNumero }],
    ['WhatsApp contra telefone', { whatsappNumero: firstBody.telefone }],
  ]) await t.test(label, async () => {
    for (const contratarSemTrial of [false, true]) {
      const result = await signup(body({ ...change, contratarSemTrial }));
      assert.equal(result.status, 409); assert.equal(result.data.code, 'ASSINATURA_EXISTENTE');
      assert.equal(result.data.assinatura, undefined);
    }
  });
  for (const status of ['ativo', 'pendente', 'bloqueado']) await t.test('protege conta existente: ' + status, async () => {
    await db.runAsync('UPDATE assinaturas SET status=$2,proximo_vencimento=$3 WHERE id=$1', [id, status, '2000-01-01']);
    const result = await signup(body({ email: firstBody.email }));
    assert.equal(result.status, 409); assert.equal(result.data.code, 'ASSINATURA_EXISTENTE');
  });
  const beforeClaims = await db.allAsync('SELECT * FROM trial_claims ORDER BY identity_hash');
  await db.runAsync('DELETE FROM assinaturas WHERE id=$1', [id]);
  for (const field of ['email', 'telefone', 'whatsappNumero']) await t.test('conta excluída mantém bloqueio de trial: ' + field, async () => {
    const result = await signup(body({ [field]: firstBody[field] }));
    assert.equal(result.status, 409); assert.equal(result.data.code, 'TRIAL_JA_UTILIZADO');
    assert.equal(result.data.assinatura, undefined);
    assert.equal((await db.getAsync('SELECT count(*)::int AS n FROM assinaturas')).n, 1);
    assert.deepEqual(await db.allAsync('SELECT * FROM trial_claims ORDER BY identity_hash'), beforeClaims);
  });
  await t.test('escolha explícita permite contratar e gerar checkout sem acesso grátis', async () => {
    const result = await signup({ ...firstBody, contratarSemTrial: true });
    assert.equal(result.status, 201); assert.equal(result.data.trialIniciado, false);
    const newId = result.data.assinatura.id;
    const account = await db.getAsync('SELECT * FROM assinaturas WHERE id=$1', [newId]);
    assert.equal(account.trial_status, null); assert.equal(account.trial_started_at, null);
    assert.equal(account.trial_ends_at, null); assert.equal(avaliarAcessoAssinatura(account).liberado, false);
    assert.deepEqual(await db.allAsync('SELECT * FROM trial_claims ORDER BY identity_hash'), beforeClaims);
    const checkout = await request(`/publico/assinaturas/${newId}/checkout`, { senha: firstBody.senha });
    assert.equal(checkout.status, 200); assert.equal(checkout.data.checkoutUrl, 'https://sandbox.mercadopago.com.br/fixture-checkout');
    assert.equal(avaliarAcessoAssinatura(await db.getAsync('SELECT * FROM assinaturas WHERE id=$1', [newId])).liberado, false);
    await db.runAsync('DELETE FROM mercado_pago_orders WHERE assinatura_id=$1', [newId]);
    await db.runAsync('DELETE FROM assinaturas WHERE id=$1', [newId]);
    const repeat = await signup(firstBody);
    assert.equal(repeat.status, 409); assert.equal(repeat.data.code, 'TRIAL_JA_UTILIZADO');
    assert.deepEqual(await db.allAsync('SELECT * FROM trial_claims ORDER BY identity_hash'), beforeClaims);
  });
  await t.test('strings e números não autorizam contratação sem trial', async () => {
    for (const contratarSemTrial of ['true', 'false', 1]) assert.equal((await signup(body({ contratarSemTrial }))).status, 400);
  });
  assert.ok(identities(firstBody).hashes.length > 0);
});
