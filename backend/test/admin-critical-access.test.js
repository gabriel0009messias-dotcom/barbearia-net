const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const { avaliarAcessoAssinatura } = require('../services/access');
const { accessState, TRIAL_MS } = require('../services/trial');

test('suspensao administrativa precede todas as fontes de direito, inclusive helper de trial', () => {
  const now = Date.now();
  const trial = { trial_status: 'active', trial_started_at: new Date(now - 1000).toISOString(),
    trial_ends_at: new Date(now - 1000 + TRIAL_MS).toISOString() };
  for (const account of [
    { status: 'pendente', ...trial },
    { status: 'ativo', proximo_vencimento: '2099-01-01', payment_id: 'fixture' },
    { status: 'atrasada', proximo_vencimento: new Date(now - 86400000).toISOString().slice(0, 10) },
    { status: 'pendente', acesso_manual_ate: '2099-01-01T00:00:00Z' },
  ]) {
    const blocked = { ...account, bloqueio_admin: true };
    assert.equal(avaliarAcessoAssinatura(blocked).status, 'admin_blocked');
    assert.equal(avaliarAcessoAssinatura(blocked).liberado, false);
    assert.equal(accessState(blocked, { liberado: true }, now).liberado, false);
    assert.equal(avaliarAcessoAssinatura({ ...blocked, bloqueio_admin: false }).liberado, true);
  }
});

test('criticos: API real, pagamento simulado, dias manuais e desbloqueio exclusivo Admin', async t => {
  const env = require('./helpers/postgres').testEnvironment();
  Object.assign(process.env, { LEGACY_ADMIN_EMAIL: 'critical-admin@example.test',
    LEGACY_ADMIN_PASSWORD: crypto.randomUUID(), MERCADO_PAGO_ACCESS_TOKEN: crypto.randomUUID(),
    MERCADO_PAGO_WEBHOOK_SECRET: crypto.randomUUID(), MERCADO_PAGO_MODE: 'test',
    PUBLIC_APP_URL: 'https://example.test', EVOLUTION_API_URL: '', EVOLUTION_API_KEY: '' });
  const db = require('../database'); await db.ready;
  const app = express(); app.use(express.json()); app.use('/api', require('../routes'));
  app.use(express.static(path.resolve(__dirname, '../public')));
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  const nativeFetch = global.fetch, payments = new Map();
  t.mock.method(global, 'fetch', async url => {
    if (String(url).endsWith('/users/me')) return Response.json({ email: 'synthetic-seller@example.test' });
    if (String(url).endsWith('/checkout/preferences')) return Response.json({ id: crypto.randomUUID(), sandbox_init_point: 'https://sandbox.mercadopago.com.br/synthetic' });
    const match = /^https:\/\/api\.mercadopago\.com\/v1\/payments\/(\d+)$/.exec(String(url));
    assert.ok(match, 'Somente consulta simulada de pagamento');
    assert.ok(payments.has(match[1])); return Response.json(payments.get(match[1]));
  });
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); await db.close(); await env.cleanup(); });
  const api = async (route, method = 'GET', body, headers = {}) => {
    const r = await nativeFetch(`http://127.0.0.1:${server.address().port}/api${route}`, {
      method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
    }); return { status: r.status, cache: r.headers.get('cache-control'), body: await r.json() };
  };
  const login = await api('/admin/login', 'POST', { email: process.env.LEGACY_ADMIN_EMAIL, senha: process.env.LEGACY_ADMIN_PASSWORD });
  assert.equal(login.status, 200); assert.equal(login.cache, 'no-store');
  const admin = { 'x-admin-token': login.body.token }, accounts = [];
  for (let n = 0; n < 5; n++) {
    const body = { barbeariaNome: 'Synthetic critical ' + n, responsavelNome: 'Fixture',
      telefone: '1198111200' + n, email: `critical-${n}@example.test`, senha: 'synthetic-owner-password',
      metodoPagamento: 'mercado_pago', diaVencimento: 5, servicos: [{ nome: 'Fixture service', preco: 30 }] };
    const created = await api('/publico/assinaturas', 'POST', body); assert.equal(created.status, 201);
    const id = created.body.assinatura.id;
    const session = await api('/barbeiro/login', 'POST', { identificador: body.email, senha: body.senha });
    accounts.push({ id, body, headers: { 'x-barbeiro-token': session.body.token } });
  }
  const [trial, paid, grace, manual, expired] = accounts;
  await db.runAsync("UPDATE assinaturas SET status='ativo',status_assinatura='ATIVA',ultimo_pagamento='2026-01-01',proximo_vencimento='2099-01-01' WHERE id=$1", [paid.id]);
  await db.runAsync("UPDATE assinaturas SET status='atrasada',ultimo_pagamento='2026-01-01',proximo_vencimento=$1 WHERE id=$2", [new Date(Date.now() - 86400000).toISOString().slice(0, 10), grace.id]);
  await db.runAsync("UPDATE assinaturas SET trial_status=NULL,acesso_manual_ate='2099-01-01T00:00:00Z' WHERE id=$1", [manual.id]);
  await db.runAsync("UPDATE assinaturas SET trial_started_at='2000-01-01T00:00:00Z',trial_ends_at='2000-01-08T00:00:00Z' WHERE id=$1", [expired.id]);
  const stored = id => db.getAsync('SELECT * FROM assinaturas WHERE id=$1', [id]);
  const block = account => api(`/admin/assinaturas/${account.id}/bloquear`, 'POST', {}, admin);
  const unlock = (account, headers = admin) => api(`/admin/assinaturas/${account.id}/desbloquear`, 'POST', {}, headers);
  const notify = id => {
    const ts = String(Date.now()), requestId = crypto.randomUUID();
    const v1 = crypto.createHmac('sha256', process.env.MERCADO_PAGO_WEBHOOK_SECRET).update(`id:${id};request-id:${requestId};ts:${ts};`).digest('hex');
    return api(`/mercadopago/webhook?data.id=${id}&type=payment`, 'POST', { type: 'payment', data: { id } },
      { 'x-request-id': requestId, 'x-signature': `ts=${ts},v1=${v1}` });
  };
  const order = async (account, id) => {
    const reference = crypto.randomUUID();
    await db.runAsync('INSERT INTO mercado_pago_orders(reference,assinatura_id,amount_cents,live_mode,expires_at) VALUES($1,$2,6500,0,$3)', [reference, account.id, '2099-01-01']);
    payments.set(id, { id, external_reference: reference, live_mode: false, transaction_amount: 65,
      currency_id: 'BRL', status: 'approved', date_approved: new Date().toISOString() });
  };
  for (const [name, account] of [['trial', trial], ['paga', paid], ['tolerancia', grace], ['manual', manual]]) {
    await t.test(name + ': bloqueio nega APIs diretas e desbloqueio restaura a regra subjacente', async () => {
      assert.equal((await api('/studiofy/painel', 'GET', undefined, account.headers)).status, 200);
      const before = await stored(account.id); assert.equal((await block(account)).status, 200);
      for (const field of ['status', 'status_assinatura', 'proximo_vencimento', 'ultimo_pagamento', 'trial_started_at', 'acesso_manual_ate']) {
        assert.deepEqual((await stored(account.id))[field], before[field], field);
      }
      for (const route of ['/studiofy/painel', '/agendamentos', '/disponibilidade', '/faturamento', '/bloqueios', '/chat/conversations']) {
        const r = await api(route, 'GET', undefined, account.headers);
        assert.equal(r.status, 403, route); assert.equal(r.body.acesso.status, 'admin_blocked');
      }
      assert.equal((await api('/studiofy/servicos', 'POST', { nome: 'Denied', preco: 1, duracao: 30 }, account.headers)).status, 403);
      assert.equal((await api('/studiofy/pagina', 'PUT', { bloqueio_admin: false }, account.headers)).status, 403);
      assert.equal((await api('/studiofy/public/studio-' + account.id)).status, 404);
      assert.equal((await api('/studiofy/public/studio-' + account.id + '/agendamentos', 'POST', {})).status, 404);
      const session = await api('/barbeiro/login', 'POST', { identificador: account.body.email, senha: account.body.senha });
      assert.equal(session.status, 200); assert.equal(session.body.assinatura.acesso.liberado, false);
      assert.equal((await api('/barbeiro/me', 'GET', undefined, account.headers)).body.acesso.liberado, false);
      assert.equal((await api(`/publico/assinaturas/${account.id}/status?status=approved`, 'GET', undefined, account.headers)).body.liberado, false);
      assert.equal((await unlock(account, { 'x-admin-token': account.headers['x-barbeiro-token'] })).status, 401);
      assert.equal((await unlock(account, account.headers)).status, 401);
      assert.equal((await api(`/admin/assinaturas/${account.id}`, 'PATCH', { status: 'ativo', bloqueio_admin: false }, admin)).status, 400);
      assert.equal((await stored(account.id)).bloqueio_admin, true);
      assert.equal((await unlock(account)).status, 200);
      assert.equal((await api('/studiofy/painel', 'GET', undefined, account.headers)).status, 200);
    });
  }
  await t.test('pagamento e renovacao preservam suspensao e credito, incluindo webhook duplicado', async () => {
    await block(trial); await order(trial, '8001'); assert.equal((await notify('8001')).status, 200);
    const first = await stored(trial.id); assert.equal(first.bloqueio_admin, true); assert.equal(first.payment_id, '8001');
    assert.equal((await api('/studiofy/painel', 'GET', undefined, trial.headers)).status, 403);
    await order(trial, '8002'); assert.equal((await notify('8002')).status, 200);
    const second = await stored(trial.id); assert.equal(second.bloqueio_admin, true);
    assert.equal(second.proximo_vencimento, new Date(Date.parse(first.proximo_vencimento) + 30 * 86400000).toISOString().slice(0, 10));
    await notify('8002'); assert.equal((await stored(trial.id)).proximo_vencimento, second.proximo_vencimento);
    assert.equal((await api('/studiofy/painel', 'GET', undefined, trial.headers)).status, 403);
    assert.equal((await unlock(trial)).status, 200);
    assert.equal((await api('/studiofy/painel', 'GET', undefined, trial.headers)).status, 200);
  });
  await t.test('dias podem ser registrados, mas somente desbloqueio autorizado retira suspensao', async () => {
    await block(expired); const before = await stored(expired.id);
    const grant = await api(`/admin/assinaturas/${expired.id}/liberar-dias`, 'POST', { dias: 30 }, admin);
    assert.equal(grant.status, 200); assert.equal(grant.body.bloqueio_admin, true);
    const after = await stored(expired.id); assert.equal(after.bloqueio_admin, true);
    assert.ok(Date.parse(after.acesso_manual_ate) > Date.now());
    for (const field of ['payment_id', 'proximo_vencimento', 'ultimo_pagamento']) assert.equal(after[field], before[field]);
    assert.equal((await api('/studiofy/painel', 'GET', undefined, expired.headers)).status, 403);
    await unlock(expired); assert.equal((await api('/studiofy/painel', 'GET', undefined, expired.headers)).status, 200);
    await block(expired); await db.runAsync('UPDATE assinaturas SET acesso_manual_ate=NULL WHERE id=$1', [expired.id]);
    await unlock(expired); assert.equal((await api('/studiofy/painel', 'GET', undefined, expired.headers)).status, 403);
  });
  await t.test('checkout e alteracao de datas/trial nao retiram suspensao', async () => {
    await block(trial);
    assert.equal((await api(`/publico/assinaturas/${trial.id}/checkout`, 'POST', {}, trial.headers)).status, 200);
    await db.runAsync("UPDATE assinaturas SET proximo_vencimento='2099-01-01',acesso_manual_ate='2099-01-01',trial_status='active',trial_started_at=$1,trial_ends_at=$2 WHERE id=$3",
      [new Date().toISOString(), new Date(Date.now() + TRIAL_MS).toISOString(), trial.id]);
    assert.equal((await stored(trial.id)).bloqueio_admin, true);
    assert.equal((await api('/studiofy/painel', 'GET', undefined, trial.headers)).status, 403);
  });
  await t.test('corrida basica bloqueio/pagamento nunca remove suspensao, em ambas as ordens', async () => {
    for (const [n, method] of [[3, 'POST'], [4, 'PATCH']]) {
      await unlock(paid); await order(paid, '800' + n);
      const suspension = () => api(`/admin/assinaturas/${paid.id}${method === 'POST' ? '/bloquear' : ''}`, method,
        method === 'POST' ? {} : { status: 'bloqueado' }, admin);
      const responses = await Promise.all(n === 3 ? [notify('800' + n), suspension()] : [suspension(), notify('800' + n)]);
      assert.deepEqual(responses.map(r => r.status), [200, 200]);
      assert.equal((await stored(paid.id)).bloqueio_admin, true);
      assert.equal((await stored(paid.id)).payment_id, '800' + n);
      assert.equal((await api('/studiofy/painel', 'GET', undefined, paid.headers)).status, 403);
    }
  });
  await t.test('logout/login nao removem suspensao; conta nao bloqueada continua operando', async () => {
    await block(manual); await api('/barbeiro/logout', 'POST', {}, manual.headers);
    const login = await api('/barbeiro/login', 'POST', { identificador: manual.body.email, senha: manual.body.senha });
    assert.equal(login.body.assinatura.acesso.status, 'admin_blocked');
    assert.equal((await api('/studiofy/painel', 'GET', undefined, { 'x-barbeiro-token': login.body.token })).status, 403);
    assert.equal((await api('/studiofy/painel', 'GET', undefined, grace.headers)).status, 200);
  });
  await t.test('frontend adulterado nao contorna suspensao na API real', async () => {
    const puppeteer = require('puppeteer');
    const executablePath = [process.env.CHROME_PATH, puppeteer.executablePath(), 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(p => p && fs.existsSync(p));
    if (!executablePath) { t.skip('Chrome indisponivel'); return; }
    const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
    try {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${server.address().port}/login.html`);
      const results = await page.evaluate(async ({ id, token }) => {
        localStorage.setItem('barbearia_auth_token', token);
        localStorage.setItem('trial_status', 'active'); localStorage.setItem('bloqueio_admin', 'false');
        window.account = { acesso: { liberado: true } };
        const headers = { 'Content-Type': 'application/json', 'x-barbeiro-token': token };
        const edit = await fetch('/api/publico/assinaturas/' + id, { method: 'PATCH', headers, body: JSON.stringify({ bloqueio_admin: false, acesso_manual_ate: '2099-01-01' }) });
        const panel = await fetch('/api/studiofy/painel', { headers });
        const me = await fetch('/api/barbeiro/me', { headers });
        return { edit: edit.status, panel: panel.status, access: (await me.json()).acesso.status };
      }, { id: paid.id, token: paid.headers['x-barbeiro-token'] });
      assert.deepEqual(results, { edit: 403, panel: 403, access: 'admin_blocked' });
      assert.equal((await stored(paid.id)).bloqueio_admin, true);
    } finally { await browser.close(); }
  });
  await t.test('migration preserva direitos, converte somente bloqueio administrativo legado', async () => {
    await db.runAsync('ALTER TABLE assinaturas DROP COLUMN bloqueio_admin');
    await db.runAsync("UPDATE assinaturas SET status='bloqueado' WHERE id=$1", [manual.id]);
    await db.runAsync("UPDATE assinaturas SET status='bloqueada' WHERE id=$1", [expired.id]);
    const before = await stored(manual.id);
    await db.pool.query(fs.readFileSync(path.join(__dirname, '../database/migrations/013_administrative_suspension.sql'), 'utf8'));
    const after = await stored(manual.id); assert.equal(after.bloqueio_admin, true);
    for (const field of ['status', 'proximo_vencimento', 'trial_started_at', 'acesso_manual_ate']) assert.deepEqual(after[field], before[field]);
    assert.equal((await stored(expired.id)).bloqueio_admin, true);
    await unlock(manual); assert.equal((await stored(manual.id)).bloqueio_admin, false);
  });
});
