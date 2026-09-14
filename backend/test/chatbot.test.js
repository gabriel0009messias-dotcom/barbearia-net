const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const express = require('express');

test('atendimento real: persistência, agenda compartilhada, isolamento e idempotência', async t => {
  const testDb = require('./helpers/postgres').testEnvironment();
  process.env.EVOLUTION_WEBHOOK_SECRET = 'test-webhook-secret';
  const db = require('../database');
  await db.ready;
  const webhook = require('../evolutionWebhook');
  const { createScheduling, localNow } = require('../services/whatsapp/scheduling');
  const clock = () => new Date('2026-09-09T10:15:00Z'); // 07:15 São Paulo
  const scheduling = createScheduling(db, clock);
  const headers = { 'x-webhook-secret': process.env.EVOLUTION_WEBHOOK_SECRET };
  const sent = [];
  const send = async (instance, phone, text) => sent.push({ instance, phone, text });
  const payload = (text, phone = '5511999990001', instance = 'salon-a', id = crypto.randomUUID()) => ({ event: 'messages.upsert', instance, data: { key: { remoteJid: `${phone}@s.whatsapp.net`, fromMe: false, id }, message: { conversation: text } } });
  const message = async (text, phone, instance) => { await webhook.processarWebhookEvolution(payload(text, phone, instance), headers, { send, clock }); return sent.at(-1)?.text; };
  const state = async (phone = '5511999990001', tenant = 1) => JSON.parse((await db.getAsync("SELECT data_json FROM sessoes WHERE assinatura_id = $1 AND telefone = $2", [tenant, phone])).data_json);
  for (const [id, instance] of [[1, 'salon-a'], [2, 'salon-b']]) {
    await db.runAsync(`INSERT INTO assinaturas (id, barbearia_nome, responsavel_nome, telefone, metodo_pagamento, dia_vencimento, suporte_numero, whatsapp_session, whatsapp_bridge_token, status, localizacao_rua)
      VALUES ($1, 'Salão Teste', 'Dono', '5511888888888', 'pix', 5, '', $2, $3, 'ativo', $4)`, [id, instance, `bridge-${id}`, `Rua ${id}`]);
    await db.runAsync("INSERT INTO servicos_assinatura (assinatura_id, nome, preco) VALUES ($1, $2, $3)", [id, `Corte ${id}`, id * 30]);
  }
  await db.runAsync("INSERT INTO bloqueios (assinatura_id, data, hora) VALUES (1, '2026-09-09', '08:30')");
  const app = express(); app.use(express.json()); app.use('/api', require('../routes'));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await new Promise(resolve => db.close(resolve)); await testDb.cleanup(); });

  await t.test('envelope: ignora próprio bot, grupos, status, evento incorreto e LID sem telefone', async () => {
    assert.equal(webhook.extract({ ...payload('oi'), event: 'connection.update' }), null);
    for (const remote of ['123@g.us', 'status@broadcast', '123456789012@lid']) { const p = payload('oi'); p.data.key.remoteJid = remote; assert.equal(webhook.extract(p), null); }
    const own = payload('oi'); own.data.key.fromMe = true; assert.equal(webhook.extract(own), null);
    const lid = payload('oi'); lid.data.key.remoteJid = 'opaque@lid'; lid.data.key.remoteJidAlt = '5511999990001@s.whatsapp.net'; assert.equal(webhook.extract(lid).phone, '5511999990001');
    await assert.rejects(webhook.processarWebhookEvolution(payload('oi'), {}), { statusCode: 401 });
    const response = await fetch(`${base}/api/webhook/evolution`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload('oi')) });
    assert.equal(response.status, 401);
    const unknown = await webhook.processarWebhookEvolution(payload('oi', undefined, 'unknown'), headers, { send, clock }); assert.equal(unknown.ignored, true);
  });
  await t.test('cliente novo: serviço real, datas, bloqueio, nome, resumo, confirmação e painel', async () => {
    assert.match(await message('Olá'), /Realizar agendamento/);
    assert.match(await message('1'), /Corte 1/);
    assert.doesNotMatch(sent.at(-1).text, /Corte 2/);
    await message('1'); const dates = (await state()).dates;
    assert.ok(dates.every(d => d >= '2026-09-09' && d < '2026-09-23'));
    assert.ok(!dates.includes('2026-09-13'));
    await message('1'); assert.ok(!(await state()).times.includes('08:30'));
    await message('1'); assert.equal((await state()).state, 'AGUARDANDO_NOME');
    await message('Gabriel'); assert.match(sent.at(-1).text, /Resumo do agendamento/);
    assert.equal((await db.getAsync('SELECT COUNT(*) AS n FROM agendamentos')).n, 0);
    assert.match(await message('1'), /Agendamento confirmado/);
    const response = await fetch(`${base}/api/agendamentos`, { headers: { 'x-whatsapp-bridge-token': 'bridge-1' } });
    assert.equal(response.status, 200); const rows = await response.json(); assert.equal(rows.length, 1); assert.equal(rows[0].cliente, 'Gabriel'); assert.equal(rows[0].status, 'confirmado');
    assert.ok(!(await scheduling.times(1, '2026-09-09')).includes('08:00'));
  });
  await t.test('mensagem inválida mantém etapa; preços, endereço e comandos', async () => {
    for (const command of ['MENU', 'CANCELAR', 'RECOMEÇAR']) { await message(command); assert.equal((await state()).state, 'MENU'); }
    await message('2'); assert.match(sent.at(-1).text, /30,00/);
    await message('0'); await message('3'); assert.match(sent.at(-1).text, /Rua 1/);
    await message('MENU'); await message('1'); const before = await state();
    await message('1abc'); assert.equal((await state()).state, before.state); assert.match(sent.at(-1).text, /Não consegui entender/);
  });
  await t.test('cliente conhecido, alterações e reinício em outro processo', async () => {
    await message('1'); await message('1'); await message('1'); assert.equal((await state()).state, 'CONFIRMANDO');
    await message('4'); assert.equal((await state()).state, 'ESCOLHENDO_HORARIO');
    const output = execFileSync(process.execPath, ['-e', "const db=require('./database');db.ready.then(async()=>{const r=await db.getAsync('SELECT etapa FROM sessoes WHERE assinatura_id=1 AND telefone=$1',['5511999990001']);console.log('STATE='+r.etapa);db.close();})"], { cwd: path.resolve(__dirname, '..'), env: process.env, encoding: 'utf8' });
    assert.match(output, /STATE=ESCOLHENDO_HORARIO/);
    await message('1'); await message('3'); assert.equal((await state()).state, 'ESCOLHENDO_DATA');
    await message('1'); await message('1'); await message('2'); assert.equal((await state()).state, 'ESCOLHENDO_SERVICO');
  });
  await t.test('duas pessoas: disputa pelo mesmo horário cria somente uma reserva', async () => {
    const phones = ['5511999990002', '5511999990003'];
    for (const phone of phones) { for (const text of ['oi', '1', '1', '1', '1', 'Cliente Teste']) await message(text, phone); }
    assert.equal((await state(phones[0])).time, (await state(phones[1])).time);
    const count = (await db.getAsync('SELECT COUNT(*) AS n FROM agendamentos')).n;
    await Promise.all(phones.map(phone => message('1', phone)));
    assert.equal((await db.getAsync('SELECT COUNT(*) AS n FROM agendamentos')).n, count + 1);
    assert.ok(sent.some(s => /acabou de ficar indisponível/.test(s.text)));
  });
  await t.test('webhook duplicado inclusive concorrente e após recarregar o módulo', async () => {
    const p = payload('MENU', '5511999990004');
    const count = sent.length;
    await Promise.all([webhook.processarWebhookEvolution(p, headers, { send, clock }), webhook.processarWebhookEvolution(p, headers, { send, clock })]);
    assert.equal(sent.length, count + 1);
    delete require.cache[require.resolve('../evolutionWebhook')];
    assert.equal((await require('../evolutionWebhook').processarWebhookEvolution(p, headers, { send, clock })).duplicate, true);
    assert.equal(sent.length, count + 1);
  });
  await t.test('salões diferentes podem reservar mesmo horário sem misturar nomes e serviços', async () => {
    for (const text of ['oi', '1', '1', '1', '1']) await message(text, '5511999990001', 'salon-b');
    assert.equal((await state('5511999990001', 2)).state, 'AGUARDANDO_NOME');
    await message('Outro Cliente', '5511999990001', 'salon-b'); await message('1', '5511999990001', 'salon-b');
    const row = await db.getAsync('SELECT * FROM agendamentos WHERE assinatura_id = 2'); assert.equal(row.hora, '08:00'); assert.equal(row.servico_nome, 'Corte 2');
  });
  await t.test('cancelamento pede confirmação e reflete status no banco/painel', async () => {
    await message('MENU'); await message('4'); assert.equal((await state()).state, 'CONFIRMAR_CANCELAMENTO');
    await message('2'); assert.equal((await db.getAsync("SELECT COUNT(*) AS n FROM agendamentos WHERE telefone='5511999990001' AND assinatura_id=1 AND status='confirmado'")).n, 1);
    await message('4'); assert.match(await message('1'), /Agendamento cancelado/);
    assert.ok((await scheduling.times(1, '2026-09-09')).includes('08:00'));
    assert.equal((await db.getAsync('SELECT status FROM agendamentos WHERE assinatura_id=2')).status, 'confirmado');
  });
  await t.test('falha de envio mantém resposta e retoma sem avançar sessão novamente', async () => {
    const p = payload('oi', '5511999990005');
    await webhook.processarWebhookEvolution(p, headers, { clock, send: async () => { throw new Error('fake failure'); } });
    const row = await db.getAsync("SELECT * FROM whatsapp_messages WHERE message_id = $1", [p.data.key.id]); assert.equal(row.status, 'pending');
    await db.runAsync("UPDATE whatsapp_messages SET lease_until=0 WHERE id=$1", [row.id]);
    await webhook.drain(send);
    assert.equal((await db.getAsync("SELECT status FROM whatsapp_messages WHERE id=$1", [row.id])).status, 'sent');
    assert.equal((await state('5511999990005')).state, 'MENU');
  });
  await t.test('fuso horário e horário passado; API do site usa a mesma regra e banco', async () => {
    assert.deepEqual(localNow(new Date('2026-09-10T01:00:00Z')), { date: '2026-09-09', time: '22:00' });
    const late = createScheduling(db, () => new Date('2026-09-09T13:00:00Z'));
    assert.ok((await late.times(1, '2026-09-09')).every(time => time > '10:00'));
    assert.deepEqual(await scheduling.times(1, '2026-09-08'), []);
    assert.deepEqual(await scheduling.times(1, '2026-09-13'), []);
    const response = await fetch(`${base}/api/agendamentos`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-whatsapp-bridge-token': 'bridge-1' }, body: JSON.stringify({ cliente: 'Cliente Site', telefone: '5511888881111', servicoId: 1, data: '2020-01-01', hora: '08:00' }) });
    assert.equal(response.status, 409);
    const liveScheduling = createScheduling(db);
    const [day] = await liveScheduling.dates(1);
    assert.ok(day);
    const availability = await fetch(`${base}/api/disponibilidade?data=${day}`, { headers: { 'x-whatsapp-bridge-token': 'bridge-1' } }).then(r => r.json());
    const slot = availability.horarios[0];
    const body = { cliente: 'Cliente Site', telefone: '5511888881111', servicoId: 1, data: day, hora: slot };
    const book = () => fetch(`${base}/api/agendamentos`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-whatsapp-bridge-token': 'bridge-1' }, body: JSON.stringify(body) });
    const results = await Promise.all([book(), book()]);
    assert.deepEqual(results.map(r => r.status).sort(), [201, 409]);
    assert.ok(!(await liveScheduling.times(1, day)).includes(slot));
  });
  await t.test('vários agendamentos: seleção, telefone legado e isolamento no cancelamento', async () => {
    for (const time of ['15:00', '16:00']) await db.runAsync("INSERT INTO agendamentos (assinatura_id, telefone, nome_cliente, servico_nome, data, hora, status) VALUES (1, '+55 (11) 99999-0099', 'Cliente Antigo', 'Corte 1', '2026-09-10', $1, 'confirmado')", [time]);
    const phone = '5511999990099';
    assert.equal(await scheduling.knownName(1, phone), 'Cliente Antigo');
    await message('oi', phone); await message('4', phone);
    assert.equal((await state(phone)).state, 'CANCELANDO_AGENDAMENTO');
    await message('2', phone); assert.equal((await state(phone)).appointment.time, '16:00');
    await message('1', phone);
    assert.equal((await scheduling.future(1, phone)).length, 1);
    const other = await db.getAsync('SELECT id FROM agendamentos WHERE assinatura_id = 2');
    assert.equal(await scheduling.cancel(1, phone, other.id), false);
  });
});
