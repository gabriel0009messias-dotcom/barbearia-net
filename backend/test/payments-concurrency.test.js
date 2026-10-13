const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const path = require('node:path');
const { fork } = require('node:child_process');

test('Etapa 2: pagamento, renovacao, identidade e checkout em PostgreSQL real isolado', async t => {
  const env = require('./helpers/postgres').testEnvironment();
  Object.assign(process.env, { LEGACY_ADMIN_EMAIL: 'stage2-admin@example.test', LEGACY_ADMIN_PASSWORD: crypto.randomUUID(),
    MERCADO_PAGO_ACCESS_TOKEN: crypto.randomUUID(), MERCADO_PAGO_WEBHOOK_SECRET: crypto.randomUUID(), MERCADO_PAGO_MODE: 'test',
    PUBLIC_APP_URL: 'https://example.test', EVOLUTION_API_URL: '', EVOLUTION_API_KEY: '' });
  const db = require('../database'); await db.ready;
  const remote = express(); remote.use(express.json());
  const remotePayments = new Map(), preferences = new Map(), posts = [];
  let lostResponse = false, hold, entered;
  remote.get('/users/me', (_req, res) => res.json({ email: 'synthetic-seller@example.test' }));
  remote.post('/checkout/preferences', async (req, res) => {
    posts.push(req.body);
    const id = 'preference-' + posts.length;
    const preference = { ...req.body, id, init_point: 'https://www.mercadopago.com.br/' + id,
      sandbox_init_point: 'https://sandbox.mercadopago.com.br/' + id };
    preferences.set(id, preference);
    entered?.(); if (hold) await hold;
    if (lostResponse) { lostResponse = false; res.destroy(); return; }
    res.json(preference);
  });
  remote.get('/checkout/preferences/search', (req, res) => {
    const elements = [...preferences.values()].filter(p => p.external_reference === req.query.external_reference);
    res.json({ elements: elements.map(p => ({ id: p.id })), total: elements.length });
  });
  remote.get('/checkout/preferences/:id', (req, res) => res.json(preferences.get(req.params.id) || {}));
  remote.get('/v1/payments/:id', (req, res) => res.json(remotePayments.get(req.params.id) || {}));
  const provider = remote.listen(0, '127.0.0.1'); await new Promise(r => provider.once('listening', r));
  const providerUrl = `http://127.0.0.1:${provider.address().port}`;
  const nativeFetch = global.fetch;
  t.mock.method(global, 'fetch', (url, options) => {
    const target = new URL(String(url));
    assert.equal(target.origin, 'https://api.mercadopago.com', 'Only simulated Mercado Pago requests');
    return nativeFetch(providerUrl + target.pathname + target.search, options);
  });
  const app = express(); app.use(express.json()); app.use('/api', require('../routes'));
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  t.after(async () => {
    hold = null; entered = null;
    for (const s of [server, provider]) { s.closeAllConnections(); await new Promise(r => s.close(r)); }
    await db.close(); await env.cleanup();
  });
  const api = async (p, method = 'GET', body, headers = {}) => {
    const r = await nativeFetch(`http://127.0.0.1:${server.address().port}/api${p}`, { method,
      headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const adminLogin = await api('/admin/login', 'POST', { email: process.env.LEGACY_ADMIN_EMAIL, senha: process.env.LEGACY_ADMIN_PASSWORD });
  const admin = { 'x-admin-token': adminLogin.body.token };
  let sequence = 0, paymentSequence = 90000;
  async function account() {
    const n = ++sequence, body = { barbeariaNome: 'Synthetic stage2 ' + n, responsavelNome: 'Fixture',
      telefone: '1198123' + String(n).padStart(4, '0'), email: `stage2-${n}@example.test`, senha: 'synthetic-owner-password',
      metodoPagamento: 'mercado_pago', diaVencimento: 5, servicos: [{ nome: 'Fixture', preco: 30 }] };
    const created = await api('/publico/assinaturas', 'POST', body); assert.equal(created.status, 201);
    const id = created.body.assinatura.id;
    const session = await api('/barbeiro/login', 'POST', { identificador: body.email, senha: body.senha });
    return { id, headers: { 'x-barbeiro-token': session.body.token } };
  }
  const stored = owner => db.getAsync('SELECT * FROM assinaturas WHERE id=$1', [owner.id]);
  const payments = require('../services/payments/mercadoPago');
  const plus = (date, days) => new Date(Date.parse(date + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  async function payment(owner, paid = today + 'T12:00:00Z', reference) {
    const id = String(++paymentSequence), ref = reference || crypto.randomUUID();
    if (!reference) await db.runAsync('INSERT INTO mercado_pago_orders(reference,assinatura_id,amount_cents,live_mode,expires_at) VALUES($1,$2,6500,0,$3)', [ref, owner.id, '2099-01-01']);
    remotePayments.set(id, { id, external_reference: ref, status: 'approved', live_mode: false,
      currency_id: 'BRL', transaction_amount: 65, date_approved: paid });
    return { id, reference: ref };
  }
  const notify = p => {
    const ts = String(Date.now()), requestId = crypto.randomUUID();
    const v1 = crypto.createHmac('sha256', process.env.MERCADO_PAGO_WEBHOOK_SECRET).update(`id:${p.id};request-id:${requestId};ts:${ts};`).digest('hex');
    return api(`/mercadopago/webhook?data.id=${p.id}`, 'POST', { type: 'payment', data: { id: p.id } },
      { 'x-request-id': requestId, 'x-signature': `ts=${ts},v1=${v1}` });
  };
  const worker = (action, id, owner) => new Promise((resolve, reject) => {
    const child = fork(path.join(__dirname, 'helpers/payment-worker.js'), [action, String(id), String(owner?.id || '')], {
      env: { ...process.env, TEST_PAYMENT_PROVIDER: providerUrl }, windowsHide: true, silent: true,
    });
    let message; child.on('message', m => { message = m; }); child.on('error', reject);
    child.stdout.resume(); child.stderr.resume();
    child.on('exit', code => code === 0 && message ? resolve(message) : reject(Error('Worker failed')));
  });
  for (const [name, due, expected] of [['antecipada', plus(today, 10), plus(today, 40)], ['no vencimento', today, plus(today, 30)], ['vencida', plus(today, -10), plus(today, 30)]]) {
    await t.test('renovacao ' + name + ' conserva os dias contratados', async () => {
      const a = await account(); await db.runAsync("UPDATE assinaturas SET status='ativo',ultimo_pagamento=$1,proximo_vencimento=$2 WHERE id=$3", [plus(today, -20), due, a.id]);
      const p = await payment(a); await payments.reconcile(p.id, a.id);
      assert.equal((await stored(a)).proximo_vencimento, expected);
      const ledger = await db.getAsync('SELECT * FROM mercado_pago_payments WHERE payment_id=$1', [p.id]);
      const expectedBase = due > today ? due + 'T03:00:00.000Z' : today + 'T12:00:00.000Z';
      assert.equal(ledger.period_base, expectedBase); assert.equal(ledger.period_ends, new Date(Date.parse(expectedBase)+30*86400000).toISOString());
      assert.equal(new Date((await stored(a)).vencimento_em).toISOString(),ledger.period_ends);
    });
  }
  await t.test('data futura sem periodo pago nao concede dias gratuitos na primeira aprovacao', async () => {
    const a = await account(); await db.runAsync('UPDATE assinaturas SET proximo_vencimento=$1 WHERE id=$2', [plus(today, 60), a.id]);
    const p = await payment(a); await payments.reconcile(p.id, a.id);
    assert.equal((await stored(a)).proximo_vencimento, plus(today, 30));
  });
  await t.test('10 webhooks simultaneos do mesmo pagamento aplicam somente um periodo', async () => {
    const a = await account(), p = await payment(a);
    assert.deepEqual((await Promise.all(Array.from({ length: 10 }, () => notify(p)))).map(r => r.status), Array(10).fill(200));
    assert.equal((await stored(a)).proximo_vencimento, plus(today, 30));
    assert.equal((await db.getAsync('SELECT count(*)::int AS n FROM mercado_pago_payments WHERE assinatura_id=$1 AND credited_at IS NOT NULL', [a.id])).n, 1);
  });
  await t.test('dois pagamentos distintos do mesmo checkout creditam dois periodos, sem perder dinheiro recebido', async () => {
    const a = await account(), first = await payment(a), second = await payment(a, undefined, first.reference);
    await Promise.all([payments.reconcile(first.id, a.id), payments.reconcile(second.id, a.id)]);
    assert.equal((await stored(a)).proximo_vencimento, plus(today, 60));
    await payments.reconcile(first.id, a.id); await payments.reconcile(second.id, a.id);
    assert.equal((await stored(a)).proximo_vencimento, plus(today, 60));
  });
  await t.test('duas instancias e reinicio nao duplicam nem perdem pagamentos', async () => {
    const a = await account(), first = await payment(a), second = await payment(a);
    const result = await Promise.all([worker('reconcile', first.id, a), worker('reconcile', second.id, a)]);
    assert.ok(result.every(r => r.ok)); assert.equal((await stored(a)).proximo_vencimento, plus(today, 60));
    assert.equal((await worker('reconcile', first.id, a)).result.activated, false);
    assert.equal((await stored(a)).proximo_vencimento, plus(today, 60));
  });
  await t.test('mesmo pagamento concorrente em duas instancias aplica somente uma vez', async () => {
    const a = await account(), p = await payment(a);
    const result = await Promise.all([worker('reconcile', p.id, a), worker('reconcile', p.id, a)]);
    assert.ok(result.every(r => r.ok)); assert.equal(result.filter(r => r.result.activated).length, 1);
    assert.equal((await stored(a)).proximo_vencimento, plus(today, 30));
  });
  await t.test('bloquear/desbloquear e aprovar concorrentemente preservam flag e credito', async () => {
    const a = await account(), p = await payment(a);
    const result = await Promise.all([notify(p), api(`/admin/assinaturas/${a.id}/bloquear`, 'POST', {}, admin)]);
    assert.deepEqual(result.map(r => r.status), [200, 200]);
    assert.equal((await stored(a)).bloqueio_admin, true); assert.equal((await stored(a)).proximo_vencimento, plus(today, 30));
    assert.equal((await api('/studiofy/painel', 'GET', undefined, a.headers)).status, 403);
    const next = await payment(a);
    await Promise.all([notify(next), api(`/admin/assinaturas/${a.id}/desbloquear`, 'POST', {}, admin)]);
    assert.equal((await stored(a)).bloqueio_admin, false); assert.equal((await stored(a)).proximo_vencimento, plus(today, 60));
    assert.equal((await api('/studiofy/painel', 'GET', undefined, a.headers)).status, 200);
  });
  await t.test('snapshot antigo de vencimento nao regrava bloqueio apos renovacao', async () => {
    const a = await account(); await db.runAsync("UPDATE assinaturas SET status='ativo',ultimo_pagamento='2000-01-01',proximo_vencimento='2000-01-01' WHERE id=$1", [a.id]);
    const p = await payment(a), original = db.get; let armed = true;
    const mock = t.mock.method(db, 'get', (sql, params, callback) => original(sql, params, (error, row) => {
      if (!error && armed && sql === 'SELECT * FROM assinaturas WHERE id = $1' && params[0] === a.id) {
        armed = false; payments.reconcile(p.id, a.id).then(() => callback(null, row), callback);
      } else callback(error, row);
    }));
    try { assert.equal((await api(`/publico/assinaturas/${a.id}/status`, 'GET', undefined, a.headers)).body.liberado, true); }
    finally { mock.mock.restore(); }
    assert.equal(armed, false); assert.equal((await stored(a)).bloqueado, 0);
  });
  await t.test('PATCH administrativo nao perde datas pagas concorrentes', async () => {
    const a = await account(), p = await payment(a);
    await Promise.all([notify(p), api(`/admin/assinaturas/${a.id}`, 'PATCH', { status: 'pausada' }, admin)]);
    assert.equal((await stored(a)).proximo_vencimento, plus(today, 30));
    assert.equal((await stored(a)).payment_id, p.id);
  });
  await t.test('snapshot antigo ao bloquear nao sobrescreve o credito; dois bloqueios nao concedem acesso', async () => {
    const a = await account(), p = await payment(a);
    await payments.reconcile(p.id, a.id); const before = (await stored(a)).proximo_vencimento;
    const next = await payment(a);
    const result = await Promise.all([notify(next), api(`/admin/assinaturas/${a.id}`, 'PATCH', { status: 'bloqueado' }, admin),
      api(`/admin/assinaturas/${a.id}/bloquear`, 'POST', {}, admin)]);
    assert.deepEqual(result.map(r => r.status), [200, 200, 200]);
    assert.equal((await stored(a)).proximo_vencimento, plus(before, 30));
    assert.equal((await stored(a)).bloqueio_admin, true);
    assert.equal((await api('/studiofy/painel', 'GET', undefined, a.headers)).status, 403);
  });
  await t.test('conta esperada, referencia, preco e metadata nao mudam beneficiario', async () => {
    const a = await account(), b = await account(), p = await payment(a), beforeB = await stored(b);
    assert.equal((await api(`/publico/assinaturas/${b.id}/checkout`, 'POST', { preco: 1, dias: 365 }, a.headers)).status, 401);
    assert.equal((await api(`/admin/assinaturas/${b.id}/confirmar-pagamento`, 'POST', { paymentId: p.id }, admin)).status, 422);
    assert.equal((await api('/admin/assinaturas/0/confirmar-pagamento', 'POST', { paymentId: p.id }, admin)).status, 400);
    remotePayments.set(p.id, { ...remotePayments.get(p.id), metadata: { assinatura_id: b.id } });
    await notify(p); assert.deepEqual(await stored(b), beforeB);
    await assert.rejects(payments.reconcile(p.id, 0), { statusCode: 400 });
    const other = await payment(b); remotePayments.set(p.id, { ...remotePayments.get(p.id), external_reference: other.reference });
    await assert.rejects(payments.reconcile(p.id), { statusCode: 422 });
    await assert.rejects(db.runAsync('UPDATE mercado_pago_payments SET assinatura_id=$1 WHERE payment_id=$2', [b.id, p.id]), e => e.code === '23514');
  });
  await t.test('duplo clique e payload adulterado criam um checkout de R$65/30 dias', async () => {
    const a = await account(), before = posts.length;
    const payload = { amount: 1, dias: 365, status: 'approved', proximo_vencimento: '2099-01-01', assinatura_id: a.id + 1 };
    let release; hold = new Promise(r => { release = r; });
    const arrival = new Promise(r => { entered = r; });
    const first = api(`/publico/assinaturas/${a.id}/checkout`, 'POST', payload, a.headers);
    await arrival;
    const concurrent = await api(`/publico/assinaturas/${a.id}/checkout`, 'POST', payload, a.headers);
    assert.equal(concurrent.status, 409); release(); hold = null; entered = null;
    const result = await first; assert.equal(result.status, 200);
    const retry = await api(`/publico/assinaturas/${a.id}/checkout`, 'POST', payload, a.headers);
    assert.equal(retry.body.checkoutUrl, result.body.checkoutUrl); assert.equal(posts.length, before + 1);
    assert.equal(posts.at(-1).items[0].unit_price, 65); assert.match(posts.at(-1).items[0].title, /30 dias/);
    assert.equal((await stored(a)).proximo_vencimento, null);
  });
  await t.test('conta excluida durante criacao nao recebe link para pagar uma conta inexistente', async () => {
    const a = await account(); let release; hold = new Promise(r => { release = r; });
    const arrival = new Promise(r => { entered = r; });
    const pending = api('/publico/assinaturas/' + a.id + '/checkout', 'POST', {}, a.headers);
    try {
      await arrival;
      const listing = await api('/admin/assinaturas?incluirPendentes=1', 'GET', undefined, admin);
      const own = listing.body.pendentes.find(row => row.id === a.id);
      assert.equal((await api('/admin/assinaturas/' + a.id, 'DELETE', { confirmationToken: own.deleteConfirmationToken }, admin)).status, 200);
    } finally { release(); hold = null; entered = null; }
    const response = await pending; assert.equal(response.status, 404); assert.equal(response.body.checkoutUrl, undefined);
  });
  await t.test('checkout concorrente entre processos reserva apenas uma intencao', async () => {
    const a = await account(), before = posts.length;
    const result = await Promise.all([worker('checkout', a.id), worker('checkout', a.id)]);
    assert.ok(result.some(r => r.ok)); assert.ok(result.every(r => r.ok || r.status === 409));
    assert.equal(posts.length, before + 1);
    assert.equal((await db.getAsync('SELECT count(*)::int AS n FROM mercado_pago_orders WHERE assinatura_id=$1', [a.id])).n, 1);
  });
  await t.test('timeout apos criacao recupera preferencia validada sem novo POST, mesmo apos reinicio', async () => {
    const a = await account(), before = posts.length; lostResponse = true;
    await assert.rejects(payments.checkout(a), { statusCode: 503 });
    assert.equal((await db.getAsync('SELECT state FROM mercado_pago_checkout_intents WHERE assinatura_id=$1', [a.id])).state, 'uncertain');
    const retry = await worker('checkout', a.id); assert.equal(retry.ok, true);
    assert.equal(posts.length, before + 1); assert.equal(retry.result.id, 'preference-' + posts.length);
    assert.equal((await payments.checkout(a)).id, retry.result.id);
  });
  await t.test('resultado remoto incerto sem preferencia visivel nao cria outra cobranca', async () => {
    const a = await account(); lostResponse = true; await assert.rejects(payments.checkout(a));
    const before = posts.length, id = 'preference-' + posts.length, saved = preferences.get(id); preferences.delete(id);
    await assert.rejects(payments.checkout(a), { statusCode: 409 }); assert.equal(posts.length, before);
    preferences.set(id, saved); assert.equal((await payments.checkout(a)).id, id);
  });
  await t.test('recuperacao rejeita preferencia com referencia/valor adulterados', async () => {
    const a = await account(); lostResponse = true; await assert.rejects(payments.checkout(a));
    const id = 'preference-' + posts.length, saved = preferences.get(id); saved.items[0].unit_price = 1;
    await assert.rejects(payments.checkout(a), { statusCode: 409 });
    assert.equal((await db.getAsync('SELECT checkout_url FROM mercado_pago_orders WHERE assinatura_id=$1', [a.id])).checkout_url, null);
  });
  await t.test('checkout expirado permite nova intencao; checkout pago permite renovacao distinta', async () => {
    const a = await account(), first = await payments.checkout(a), before = posts.length;
    await db.runAsync("UPDATE mercado_pago_orders SET expires_at='2000-01-01' WHERE assinatura_id=$1", [a.id]);
    const next = await payments.checkout(a); assert.notEqual(next.id, first.id); assert.equal(posts.length, before + 1);
    const order = await db.getAsync('SELECT order_reference FROM mercado_pago_checkout_intents WHERE assinatura_id=$1', [a.id]);
    const paid = await payment(a, undefined, order.order_reference); await payments.reconcile(paid.id, a.id);
    assert.notEqual((await payments.checkout(a)).id, next.id);
  });
  await t.test('estado sending apos reinicio recupera resultado; nao repete criacao', async () => {
    const a = await account(); lostResponse = true; await assert.rejects(payments.checkout(a));
    await db.runAsync("UPDATE mercado_pago_checkout_intents SET state='sending',updated_at='2000-01-01' WHERE assinatura_id=$1", [a.id]);
    const before = posts.length; assert.equal((await worker('checkout', a.id)).ok, true); assert.equal(posts.length, before);
  });
  await t.test('constraints preservam conta da intencao e identidade/evidencia do credito', async () => {
    const a = await account(), b = await account(), p = await payment(a); await payments.reconcile(p.id, a.id);
    await assert.rejects(db.runAsync('INSERT INTO mercado_pago_checkout_intents(assinatura_id,order_reference,state) VALUES($1,$2,$3)', [b.id, p.reference, 'uncertain']), e => e.code === '23503');
    await db.runAsync('INSERT INTO mercado_pago_checkout_intents(assinatura_id,order_reference,state) VALUES($1,$2,$3)', [a.id, p.reference, 'ready']);
    await assert.rejects(db.runAsync('INSERT INTO mercado_pago_checkout_intents(assinatura_id,order_reference,state) VALUES($1,$2,$3)', [a.id, p.reference, 'ready']), e => e.code === '23505');
    await assert.rejects(db.runAsync('UPDATE mercado_pago_payments SET credited_at=NULL WHERE payment_id=$1', [p.id]), e => e.code === '23514');
    await assert.rejects(db.runAsync("UPDATE mercado_pago_payments SET period_ends='2099-01-01' WHERE payment_id=$1", [p.id]), e => e.code === '23514');
    assert.equal((await stored(a)).proximo_vencimento, plus(today, 30));
  });
});
