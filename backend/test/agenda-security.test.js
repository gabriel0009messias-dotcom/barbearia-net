const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { localMoment } = require('../services/agenda');

test('Agenda etapa 1: autorização pública, estados finais e histórico financeiro', async t => {
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
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await db.close(); await env.cleanup();
  });
  const api = async (url, owner, body, method = body ? 'POST' : 'GET') => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api${url}`, {
      method, headers: { 'Content-Type': 'application/json', ...(owner ? { 'x-barbeiro-token': owner.token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json() };
  };
  const owners = [];
  for (let n = 0; n < 2; n++) {
    const email = `agenda-security-${n}@example.test`;
    const signup = await api('/publico/assinaturas', null, { barbeariaNome: `Agenda ${n}`,
      responsavelNome: 'Ana', telefone: `1199999100${n}`, email, senha: 'synthetic-password',
      metodoPagamento: 'mercado_pago', diaVencimento: 5, servicos: [{ nome: 'Corte', preco: 30 }] });
    assert.equal(signup.status, 201);
    const id = signup.body.assinatura.id;
    await db.runAsync("UPDATE assinaturas SET acesso_manual_ate='2099-01-01',weekly_hours=$1 WHERE id=$2",
      [JSON.stringify(Array.from({ length: 7 }, () => [['08:00', '20:00']])), id]);
    const login = await api('/barbeiro/login', null, { identificador: email, senha: 'synthetic-password' });
    assert.equal(login.status, 200);
    const owner = { id, token: login.body.token };
    const panel = (await api('/studiofy/painel', owner)).body;
    owners.push({ ...owner, service: panel.servicos[0].id, professional: panel.profissionais[0].id });
  }
  const [a, b] = owners;
  const today = localMoment().date;
  const shift = n => { const d = new Date(today + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const future = shift(2), past = shift(-1);
  const body = (owner = a, extra = {}) => ({ nome_cliente: 'Cliente original', telefone: '11999992222',
    servico_id: owner.service, profissional_id: owner.professional, data: future, hora: '09:00', ...extra });
  const insert = async (status = 'confirmado', date = past, owner = a, extra = {}) => (await db.runAsync(
    'INSERT INTO agendamentos (assinatura_id,nome_cliente,telefone,servico_nome,preco,data,hora,status,profissional_id,duracao,studio_service_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
    [owner.id, 'Cliente original', '5511999992222', 'Corte', extra.preco ?? 30, date, extra.hora ?? '09:00',
      status, owner.professional, extra.duracao ?? 30, owner.service])).lastID;
  const row = id => db.getAsync('SELECT * FROM agendamentos WHERE id=$1', [id]);
  const patch = (id, status, owner = a, extra = {}) => api('/studiofy/agendamentos/' + id, owner, { status, ...extra }, 'PATCH');
  const reset = async () => {
    await db.runAsync('DELETE FROM agendamentos WHERE assinatura_id IN ($1,$2)', [a.id, b.id]);
    for (const owner of owners) await db.runAsync('UPDATE servicos_assinatura SET nome=$1,preco=30,duracao=30,ativo=true WHERE id=$2', ['Corte', owner.service]);
  };
  const publicBooking = async () => {
    const response = await api('/studiofy/public/studio-' + a.id + '/agendamentos', null, body());
    assert.equal(response.status, 201);
    const id = (await db.getAsync('SELECT appointment_id FROM public_booking_access WHERE token_hash=encode(sha256($1::bytea),\'hex\')', [Buffer.from(response.body.token)])).appointment_id;
    return { id, token: response.body.token };
  };

  await t.test('mudança de nome OU telefone invalida o link antigo para consulta e cancelamento', async () => {
    for (const change of [{ nome_cliente: 'Outro cliente' }, { telefone: '11999993333' }]) {
      await reset(); const booking = await publicBooking();
      const moved = await api('/studiofy/agendamentos/' + booking.id, a, body(a, { ...change, hora: '10:00' }), 'PUT');
      assert.equal(moved.status, 200);
      assert.equal((await db.getAsync('SELECT count(*)::int AS n FROM public_booking_access WHERE appointment_id=$1', [booking.id])).n, 0);
      const read = await api('/studiofy/public/reservas/consultar', null, { token: booking.token });
      assert.equal(read.status, 404); assert.equal(read.body.nome_cliente, undefined);
      assert.equal((await api('/studiofy/public/reservas/cancelar', null, { token: booking.token, confirmar: true })).status, 404);
      assert.equal((await row(booking.id)).status, 'confirmado');
    }
  });
  await t.test('mesmo cliente: remarcação e formato equivalente do telefone preservam o link', async () => {
    await reset(); const booking = await publicBooking();
    assert.equal((await api('/studiofy/agendamentos/' + booking.id, a, body(a, { telefone: '+55 (11) 99999-2222', hora: '10:00' }), 'PUT')).status, 200);
    const read = await api('/studiofy/public/reservas/consultar', null, { token: booking.token });
    assert.equal(read.status, 200); assert.equal(read.body.hora, '10:00');
    assert.equal(read.body.token_hash, undefined); assert.equal(read.body.token, undefined);
    assert.equal((await api('/studiofy/public/reservas/cancelar', null, { token: booking.token, confirmar: true })).status, 200);
  });
  await t.test('remarcação inválida não revoga o link nem muda os dados', async () => {
    await reset(); const booking = await publicBooking(), before = await row(booking.id);
    assert.equal((await api('/studiofy/agendamentos/' + booking.id, a, body(a, { nome_cliente: 'Outro cliente', hora: '07:00' }), 'PUT')).status, 409);
    assert.deepEqual(await row(booking.id), before);
    assert.equal((await api('/studiofy/public/reservas/consultar', null, { token: booking.token })).status, 200);
  });
  await t.test('conclusão e falta futuras recusam data/permissão forjada pelo navegador', async () => {
    await reset(); const id = await insert('confirmado', future);
    for (const status of ['concluido', 'falta']) {
      const r = await patch(id, status, a, { data: past, hora: '00:00', pode_concluir: true, futuro: false });
      assert.equal(r.status, 409); assert.match(r.body.error, /futuro|antes do horário/);
      assert.equal((await row(id)).status, 'confirmado');
    }
  });
  await t.test('conclusão válida preserva o preço histórico e não duplica receita', async () => {
    await reset(); const id = await insert();
    await db.runAsync('UPDATE servicos_assinatura SET preco=90,duracao=60 WHERE id=$1', [a.service]);
    assert.equal((await patch(id, 'concluido')).status, 200);
    assert.equal((await patch(id, 'concluido')).status, 409);
    assert.equal((await row(id)).preco, 30); assert.equal((await row(id)).duracao, 30);
    const f = (await api('/studiofy/painel', a)).body.financeiro;
    assert.deepEqual(f.total, { atendimentos: 1, valor_centavos: 3000 });
  });
  await t.test('falta válida pode ser registrada após o início', async () => {
    await reset(); const id = await insert(); assert.equal((await patch(id, 'falta')).status, 200);
    assert.equal((await row(id)).status, 'falta');
  });
  await t.test('concluído: PATCH, PUT e DELETE não alteram status, dados nem faturamento', async () => {
    await reset(); const id = await insert('concluido'), before = await row(id);
    for (const status of ['confirmado', 'concluido', 'cancelado', 'falta']) {
      assert.equal((await patch(id, status, a, { servico_id: b.service, preco: 0, duracao: 5 })).status, 409);
    }
    assert.equal((await api('/studiofy/agendamentos/' + id, a, body(a, { preco: 0, duracao: 5 }), 'PUT')).status, 409);
    assert.equal((await api('/agendamentos/' + id, a, undefined, 'DELETE')).status, 409);
    assert.deepEqual(await row(id), before);
    const f = (await api('/studiofy/painel', a)).body.financeiro;
    assert.deepEqual(f.total, { atendimentos: 1, valor_centavos: 3000 });
    assert.equal(f.servicos[0].atendimentos, 1); assert.equal(f.historico[0].valor_centavos, 3000);
  });
  await t.test('cancelado e falta são finais no PATCH, PUT e DELETE legado', async () => {
    for (const source of ['cancelado', 'falta']) {
      await reset(); const id = await insert(source, future), before = await row(id);
      for (const target of ['confirmado', 'concluido', 'cancelado', 'falta']) assert.equal((await patch(id, target)).status, 409);
      assert.equal((await api('/studiofy/agendamentos/' + id, a, body(), 'PUT')).status, 409);
      assert.equal((await api('/agendamentos/' + id, a, undefined, 'DELETE')).status, 409);
      assert.deepEqual(await row(id), before);
    }
  });
  await t.test('remarcação exige confirmado ainda futuro', async () => {
    await reset(); const pastId = await insert();
    assert.equal((await api('/studiofy/agendamentos/' + pastId, a, body(), 'PUT')).status, 409);
    const futureId = await insert('confirmado', future);
    assert.equal((await api('/studiofy/agendamentos/' + futureId, a, body(a, { hora: '10:00', status: 'concluido' }), 'PUT')).status, 200);
    assert.equal((await row(futureId)).status, 'confirmado');
  });
  await t.test('mesmo serviço mantém preço/duração; serviço novo usa catálogo', async () => {
    await reset(); const id = await insert('confirmado', future);
    await db.runAsync('UPDATE servicos_assinatura SET preco=90,duracao=60 WHERE id=$1', [a.service]);
    assert.equal((await api('/studiofy/agendamentos/' + id, a, body(a, { hora: '10:00', preco: 1, duracao: 5 }), 'PUT')).status, 200);
    assert.equal((await row(id)).preco, 30); assert.equal((await row(id)).duracao, 30);
    const newService = await api('/studiofy/servicos', a, { nome: 'Tratamento', preco: 55.2, duracao: 45 });
    assert.equal(newService.status, 201);
    assert.equal((await api('/studiofy/agendamentos/' + id, a, body(a, { hora: '11:00', servico_id: newService.body.id, preco: 1 }), 'PUT')).status, 200);
    const r = await row(id); assert.equal(r.preco, 55.2); assert.equal(r.duracao, 45); assert.equal(r.servico_nome, 'Tratamento');
  });
  await t.test('disponibilidade da remarcação usa duração histórica, não uma duração reduzida do catálogo', async () => {
    await reset(); const id = await insert('confirmado', future, a, { duracao: 60 });
    await insert('confirmado', future, a, { hora: '10:30' });
    await db.runAsync('UPDATE servicos_assinatura SET duracao=5 WHERE id=$1', [a.service]);
    assert.equal((await api('/studiofy/agendamentos/' + id, a, body(a, { hora: '10:00' }), 'PUT')).status, 409);
    assert.equal((await row(id)).hora, '09:00');
  });
  await t.test('remarcação revalida serviço, profissional, expediente e bloqueios', async () => {
    await reset(); const id = await insert('confirmado', future), before = await row(id);
    for (const extra of [{ servico_id: b.service }, { profissional_id: b.professional }, { hora: '07:00' }, { data: past }]) {
      assert.equal((await api('/studiofy/agendamentos/' + id, a, body(a, extra), 'PUT')).status, 409);
    }
    await db.runAsync('INSERT INTO bloqueios (assinatura_id,data,hora,fim,profissional_id) VALUES ($1,$2,$3,$4,$5)', [a.id, future, '15:00', '16:00', a.professional]);
    assert.equal((await api('/studiofy/agendamentos/' + id, a, body(a, { hora: '15:00' }), 'PUT')).status, 409);
    await db.runAsync('UPDATE servicos_assinatura SET ativo=false WHERE id=$1', [a.service]);
    assert.equal((await api('/studiofy/agendamentos/' + id, a, body(), 'PUT')).status, 409);
    assert.deepEqual(await row(id), before);
  });
  await t.test('disputa concluir x cancelar permite exatamente um vencedor, inclusive DELETE legado', async () => {
    for (const legacy of [false, true]) {
      for (let n = 0; n < 3; n++) {
        await reset(); const id = await insert();
        const cancel = () => legacy ? api('/agendamentos/' + id, a, undefined, 'DELETE') : patch(id, 'cancelado');
        const operations = n % 2 ? [cancel(), patch(id, 'concluido')] : [patch(id, 'concluido'), cancel()];
        const responses = await Promise.all(operations);
        assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
        const saved = await row(id); assert.ok(['cancelado', 'concluido'].includes(saved.status));
        const f = (await api('/studiofy/painel', a)).body.financeiro;
        assert.equal(f.total.valor_centavos, saved.status === 'concluido' ? 3000 : 0);
      }
    }
  });
  await t.test('isolamento: identidade e estados de outra conta não podem ser manipulados', async () => {
    await reset(); const id = await insert('confirmado', future, b), before = await row(id);
    assert.equal((await patch(id, 'cancelado', a, { assinatura_id: b.id })).status, 404);
    assert.equal((await api('/studiofy/agendamentos/' + id, a, body(b, { assinatura_id: b.id }), 'PUT')).status, 404);
    assert.equal((await api('/agendamentos/' + id, a, undefined, 'DELETE')).status, 404);
    assert.deepEqual(await row(id), before);
  });
  await t.test('IDs inválidos retornam 400 e IDs ausentes retornam 404, sem erro 500', async () => {
    await reset();
    for (const id of ['abc', '0', '-1', '99999999999999999999999999']) {
      assert.equal((await patch(id, 'cancelado')).status, 400);
      assert.equal((await api('/studiofy/agendamentos/' + id, a, body(), 'PUT')).status, 400);
      assert.equal((await api('/agendamentos/' + id, a, undefined, 'DELETE')).status, 400);
    }
    assert.equal((await patch('999999', 'cancelado')).status, 404);
    assert.equal((await api('/studiofy/agendamentos/999999', a, body(), 'PUT')).status, 404);
    assert.equal((await api('/agendamentos/999999', a, undefined, 'DELETE')).status, 404);
    for (const extra of [{ servico_id: 'abc' }, { profissional_id: [] }]) assert.equal((await api('/studiofy/agendamentos', a, body(a, extra))).status, 400);
  });
  await t.test('banco impede escritores diretos de alterar fatos encerrados e permite metadados de lembrete', async () => {
    await reset(); const id = await insert('concluido'), before = await row(id);
    for (const sql of ["UPDATE agendamentos SET status='cancelado' WHERE id=$1",
      'UPDATE agendamentos SET preco=1 WHERE id=$1', 'UPDATE agendamentos SET duracao=5 WHERE id=$1']) {
      await assert.rejects(db.runAsync(sql, [id]), e => e.code === '23514');
    }
    assert.deepEqual(await row(id), before);
    await db.runAsync('UPDATE agendamentos SET lembrete_15_enviado_em=$1 WHERE id=$2', ['2026-10-06T12:00:00Z', id]);
    assert.equal((await row(id)).preco, 30); assert.equal((await row(id)).status, 'concluido');
  });
  await t.test('autenticação é obrigatória para as mutações', async () => {
    await reset(); const id = await insert('confirmado', future);
    for (const owner of [null, { token: 'forged' }]) {
      assert.equal((await patch(id, 'cancelado', owner)).status, 401);
      assert.equal((await api('/studiofy/agendamentos/' + id, owner, body(), 'PUT')).status, 401);
      assert.equal((await api('/agendamentos/' + id, owner, undefined, 'DELETE')).status, 401);
    }
    assert.equal((await row(id)).status, 'confirmado');
  });
});
