const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const { transitionAppointment } = require('../services/agenda');

test('M-RETORNO-01: original appointment owner is immutable for SQL writers and real HTTP flows', async t => {
  const env = require('./helpers/postgres').testEnvironment();
  Object.assign(process.env, { NODE_ENV: 'test', RENDER: 'true', EVOLUTION_API_URL: '', EVOLUTION_API_KEY: '',
    EVOLUTION_WEBHOOK_SECRET: '', MERCADO_PAGO_ACCESS_TOKEN: '', MERCADO_PAGO_WEBHOOK_SECRET: '' });
  const db = require('../database'); await db.ready;
  const salt = 'synthetic-return-owner-salt', password = 'synthetic-return-owner-password';
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  const owners = [];
  for (const id of [6, 806]) {
    await db.runAsync(`INSERT INTO assinaturas(id,barbearia_nome,responsavel_nome,telefone,email,metodo_pagamento,dia_vencimento,
      suporte_numero,senha_hash,senha_salt,acesso_manual_ate,weekly_hours)
      VALUES ($1,$2,'Synthetic owner','11988886060',$3,'mercado_pago',5,'11977776060',$4,$5,'2099-01-01',$6)`,
      [id, 'Establishment ' + id, 'return-owner-' + id + '@example.test', hash, salt, JSON.stringify(Array.from({ length: 7 }, () => [['09:00', '18:00']]))]);
    const service = (await db.runAsync('INSERT INTO servicos_assinatura(assinatura_id,nome,preco) VALUES ($1,$2,30)', [id, 'Serviço livre ' + id])).lastID;
    const professional = (await db.runAsync('INSERT INTO profissionais(assinatura_id,nome) VALUES ($1,$2)', [id, 'Professional ' + id])).lastID;
    await db.runAsync('INSERT INTO profissional_servicos(assinatura_id,profissional_id,servico_id) VALUES ($1,$2,$3)', [id, professional, service]);
    owners.push({ id, service, professional });
  }
  const [a, b] = owners;
  let sequence = 0;
  const logs = [];
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) t.mock.method(console, level, (...args) => logs.push(args));
  const app = express(); app.use(express.json()); app.use('/api', require('../routes'));
  const server = app.listen(0, '127.0.0.1'); await new Promise(done => server.once('listening', done));
  const base = 'http://127.0.0.1:' + server.address().port, nativeFetch = global.fetch;
  t.mock.method(global, 'fetch', (input, options) => {
    assert.equal(new URL(String(input)).origin, base, 'Only loopback is permitted');
    return nativeFetch(input, options);
  });
  t.after(async () => { server.closeAllConnections(); await new Promise(done => server.close(done)); await db.close(); await env.cleanup(); });
  const request = async (endpoint, owner, body, method = body ? 'POST' : 'GET') => {
    const response = await fetch(base + '/api' + endpoint, { method,
      headers: { 'Content-Type': 'application/json', ...(owner ? { 'x-barbeiro-token': owner.token } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await response.text(); let data; try { data = JSON.parse(text); } catch { data = null; }
    return { status: response.status, text, data };
  };
  for (const owner of owners) {
    const login = await request('/barbeiro/login', null, { identificador: 'return-owner-' + owner.id + '@example.test', senha: password });
    assert.equal(login.status, 200); owner.token = login.data.token;
  }
  const book = async (owner = a, extra = {}) => (await db.runAsync(`INSERT INTO agendamentos(assinatura_id,nome_cliente,telefone,
    servico_nome,preco,data,hora,status,studio_service_id) VALUES ($1,$2,$3,$4,30,$5,'12:00',$6,$7)`,
    [owner.id, 'PRIVATE_OWNER_' + owner.id + '_CUSTOMER', extra.phone || '5511999996060', 'Serviço histórico ' + owner.id,
      extra.date || new Date(Date.UTC(2020, 0, ++sequence)).toISOString().slice(0, 10), extra.status || 'confirmado', owner.service])).lastID;
  const source = id => db.getAsync('SELECT * FROM agendamentos WHERE id=$1', [id]);
  const reminders = id => db.allAsync('SELECT * FROM return_reminders WHERE appointment_id=$1', [id]);
  const attack = async (id, sql, values) => {
    const before = await source(id);
    await assert.rejects(db.runAsync(sql, values), e => e.code === '23514');
    assert.deepEqual(await source(id), before);
    assert.deepEqual(await reminders(id), []);
    const panel = await request('/studiofy/painel', b);
    assert.equal(panel.status, 200);
    assert.ok(!panel.data.agendamentos.some(row => row.id === id));
    assert.ok(!panel.text.includes(before.nome_cliente));
    assert.equal((await db.getAsync('SELECT count(*)::int n FROM return_reminders WHERE assinatura_id=$1 AND appointment_id=$2', [b.id, id])).n, 0);
  };
  for (const completed of [false, true]) for (const changeService of [false, true]) {
    await t.test('direct A -> B' + (changeService ? ' + service B' : '') + (completed ? ' + completed' : ' before completion'), async () => {
      const id = await book();
      const sql = 'UPDATE agendamentos SET assinatura_id=$1' + (changeService ? ',studio_service_id=$3' : '') +
        (completed ? ",status='concluido'" : '') + ' WHERE id=$2';
      await attack(id, sql, changeService ? [b.id, id, b.service] : [b.id, id]);
    });
  }
  await t.test('original NULL owner cannot be assigned later and owned appointment cannot become ownerless', async () => {
    const legacy = (await db.runAsync("INSERT INTO agendamentos(nome_cliente,telefone,servico_nome,data,hora,status) VALUES ('Synthetic legacy','5511999996060','Legacy','1999-01-01','12:00','confirmado')")).lastID;
    await assert.rejects(db.runAsync('UPDATE agendamentos SET assinatura_id=$1,studio_service_id=$2 WHERE id=$3', [a.id, a.service, legacy]), e => e.code === '23514');
    assert.equal((await source(legacy)).assinatura_id, null);
    const id = await book(); await attack(id, 'UPDATE agendamentos SET assinatura_id=NULL,studio_service_id=NULL WHERE id=$1', [id]);
  });
  await t.test('failed transfer rolls back other writes in the same transaction', async () => {
    const id = await book(), before = await source(id);
    await assert.rejects(db.transaction(async c => {
      await c.runAsync('UPDATE servicos_assinatura SET nome=$1 WHERE id=$2', ['Temporary rolled-back name', a.service]);
      await c.runAsync("UPDATE agendamentos SET assinatura_id=$1,studio_service_id=$2,status='concluido' WHERE id=$3", [b.id, b.service, id]);
    }), e => e.code === '23514');
    assert.deepEqual(await source(id), before); assert.deepEqual(await reminders(id), []);
    assert.equal((await db.getAsync('SELECT nome FROM servicos_assinatura WHERE id=$1', [a.service])).nome, 'Serviço livre 6');
  });
  await t.test('same phone A/B stays isolated and forged appointment IDs fail through actual API', async () => {
    const idA = await book(a), idB = await book(b);
    assert.equal((await request('/studiofy/agendamentos/' + idA, b, { status: 'concluido', assinatura_id: a.id }, 'PATCH')).status, 404);
    assert.equal((await request('/studiofy/agendamentos/' + idB, a, { status: 'concluido', assinatura_id: b.id }, 'PATCH')).status, 404);
    assert.equal((await request('/studiofy/agendamentos/1e2', a, { status: 'concluido' }, 'PATCH')).status, 400);
    assert.equal((await request('/studiofy/agendamentos/' + idA, a, { status: 'concluido', assinatura_id: b.id, studio_service_id: b.service, telefone: '5511988886060' }, 'PATCH')).status, 200);
    await transitionAppointment(db, b.id, idB, 'concluido');
    const ra = (await reminders(idA))[0], rb = (await reminders(idB))[0];
    assert.equal(ra.assinatura_id, a.id); assert.equal(rb.assinatura_id, b.id);
    assert.equal(ra.phone_snapshot, rb.phone_snapshot); assert.notEqual(ra.customer_key, rb.customer_key);
    assert.equal(ra.service_identity, 'service:' + a.service); assert.equal(rb.service_identity, 'service:' + b.service);
    const panel = await request('/studiofy/painel?assinatura_id=' + a.id, b);
    assert.ok(!panel.text.includes('PRIVATE_OWNER_6_CUSTOMER'));
  });
  await t.test('concurrent native transfer and legitimate completion preserve owner and one opportunity', async () => {
    const id = await book();
    const results = await Promise.allSettled([
      db.runAsync("UPDATE agendamentos SET assinatura_id=$1,studio_service_id=$2,status='concluido' WHERE id=$3", [b.id, b.service, id]),
      db.runAsync("UPDATE agendamentos SET status='concluido' WHERE id=$1", [id]),
    ]);
    assert.equal(results[0].status, 'rejected'); assert.equal(results[0].reason.code, '23514');
    assert.equal(results[1].status, 'fulfilled');
    const after = await source(id); assert.equal(after.assinatura_id, a.id); assert.equal(after.status, 'concluido');
    const rows = await reminders(id); assert.equal(rows.length, 1); assert.equal(rows[0].assinatura_id, a.id);
  });
  await t.test('normal cancellation and absence retain owner and do not create return opportunity', async () => {
    for (const status of ['cancelado', 'falta']) {
      const id = await book(); assert.equal((await request('/studiofy/agendamentos/' + id, a, { status }, 'PATCH')).status, 200);
      assert.equal((await source(id)).assinatura_id, a.id); assert.deepEqual(await reminders(id), []);
    }
  });
  await t.test('normal API creation, future rescheduling and public page still work', async () => {
    const future = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
    const body = { nome_cliente: 'Normal customer', telefone: '11999996060', servico_id: a.service,
      profissional_id: a.professional, data: future, hora: '09:00' };
    const created = await request('/studiofy/agendamentos', a, body); assert.equal(created.status, 201);
    const id = created.data.id;
    assert.equal((await request('/studiofy/agendamentos/' + id, a, { ...body, hora: '10:00', assinatura_id: b.id }, 'PUT')).status, 200);
    assert.equal((await source(id)).assinatura_id, a.id); assert.equal((await source(id)).hora, '10:00');
    assert.deepEqual(await reminders(id), []);
    const page = await request('/studiofy/public/studio-' + a.id);
    assert.equal(page.status, 200); assert.equal(page.data.nome, 'Establishment 6');
  });
  await t.test('no sensitive logs, delivery metadata or network side effect', async () => {
    const text = JSON.stringify(logs), secret = (await db.getAsync("SELECT valor FROM configuracoes WHERE chave='return_customer_key_v1'")).valor;
    for (const marker of ['PRIVATE_OWNER_6_CUSTOMER', 'PRIVATE_OWNER_806_CUSTOMER', '5511999996060', password, hash, salt, secret]) assert.ok(!text.includes(marker));
    assert.equal((await db.getAsync('SELECT count(*)::int n FROM return_reminders WHERE sent_at IS NOT NULL OR dispatch_started_at IS NOT NULL')).n, 0);
  });
});
