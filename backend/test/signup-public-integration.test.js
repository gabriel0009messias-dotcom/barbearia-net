const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const { localMoment } = require('../services/agenda');
const { addDays } = require('../services/whatsapp/scheduling');

test('Cadastro etapa 1: DTO, entradas, disputa de catálogo e integração pública PostgreSQL', { timeout: 60000 }, async t => {
  const env = require('./helpers/postgres').testEnvironment();
  Object.assign(process.env, { MERCADO_PAGO_ACCESS_TOKEN: '', EVOLUTION_API_URL: '', EVOLUTION_API_KEY: '',
    LEGACY_ADMIN_EMAIL: 'admin@example.test', LEGACY_ADMIN_PASSWORD: 'synthetic-admin-password' });
  const db = require('../database'); await db.ready;
  const app = express(); app.use(express.json({ limit: '6mb' })); app.use('/api', require('../routes'));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await db.close(); await env.cleanup(); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const request = async (url, body, token, method = body ? 'POST' : 'GET', admin = false) => {
    const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json',
      ...(token ? { [admin ? 'x-admin-token' : 'x-barbeiro-token']: token } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, data: await res.json() };
  };
  let sequence = 0;
  const signupBody = extra => { const n = ++sequence; return {
    establishmentName: `Studio segurança ${n}`, responsavelNome: '  Ana Teste  ', businessType: 'nails',
    city: ' Recife ', state: 'pe', instagram: '@studio.teste', telefone: `1198000${String(n).padStart(4, '0')}`,
    email: `signup-security-${n}@example.test`, senha: 'synthetic-password', metodoPagamento: 'mercado_pago',
    diaVencimento: 5, servicos: [{ nome: 'Manicure', preco: 35.20, duracao: 30 }], ...extra,
  }; };
  const clean = data => {
    for (const [key, value] of Object.entries(data || {})) {
      assert.doesNotMatch(key, /senha|password|hash|salt|secret|credential|private|api_key|bridge_token/i);
      if (value && typeof value === 'object') clean(value);
    }
  };
  const create = async extra => {
    const body = signupBody(extra), response = await request('/publico/assinaturas', body);
    assert.equal(response.status, 201); clean(response.data);
    const id = response.data.assinatura.id;
    const login = await request('/barbeiro/login', { identificador: body.email, senha: body.senha });
    assert.equal(login.status, 200); clean(login.data.assinatura);
    const panel = await request('/studiofy/painel', undefined, login.data.token);
    return { id, body, token: login.data.token, service: panel.data.servicos[0], professional: panel.data.profissionais[0].id };
  };
  const a = await create(), b = await create();
  const date = addDays(localMoment().date, 2), root = `/studiofy/public/studio-${a.id}`;
  const booking = extra => ({ nome_cliente: 'Cliente Histórico', telefone: '11999992222',
    servico_id: a.service.id, profissional_id: a.professional, data: date, hora: '17:30', ...extra });
  const catalog = extra => ({ nome: 'Manicure', preco: 35.20, duracao: 30, ativo: true, ...extra });
  const edit = extra => request(`/studiofy/servicos/${a.service.id}`, catalog(extra), a.token, 'PUT');
  const reset = async () => {
    await db.runAsync('DELETE FROM agendamentos WHERE assinatura_id=$1', [a.id]);
    assert.equal((await edit({})).status, 200);
    assert.equal((await request('/studiofy/horarios', { horarios: Array.from({ length: 7 }, () => [['08:00', '18:00']]) }, a.token, 'PUT')).status, 200);
  };
  await reset();

  await t.test('falha de banco nas consultas de conta/acesso não expõe SQL ou credenciais', async subtest => {
    subtest.mock.method(db, 'get', (_sql, _params, callback) => callback(Error('SELECT senha_hash password=synthetic-secret')));
    const router = require('../routes');
    const expected = {
      '/publico/assinaturas/:id': 'Não foi possível consultar a conta.',
      '/publico/assinaturas/:id/acesso': 'Não foi possível consultar o acesso da conta.',
      '/publico/assinaturas/:id/status': 'Não foi possível consultar o estado da conta.',
      '/publico/assinatura-config': 'Não foi possível consultar a configuração do cadastro.',
    };
    for (const [route, message] of Object.entries(expected)) {
      const handler = router.stack.find(layer => layer.route?.path === route && layer.route.methods.get).route.stack.at(-1).handle;
      const response = { status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
      await handler({ params: { id: String(a.id) }, assinatura: { id: a.id } }, response);
      assert.equal(response.code, 500);
      assert.deepEqual(Object.keys(response.body), ['error']);
      assert.equal(response.body.error, message);
      assert.doesNotMatch(JSON.stringify(response.body), /SELECT|senha_hash|password|synthetic-secret/);
    }
  });

  await t.test('nenhuma resposta de cadastro/login/conta/access/admin contém credenciais da assinatura', async () => {
    await db.runAsync('UPDATE assinaturas SET whatsapp_bridge_token=$1,acesso_manual_ate=$2 WHERE id=$3', ['synthetic-private-bridge', '2099-01-01', a.id]);
    const responses = [
      await request('/barbeiro/me', undefined, a.token),
      await request(`/publico/assinaturas/${a.id}`, undefined, a.token),
      await request(`/publico/assinaturas/${a.id}/acesso`, undefined, a.token),
      await request('/barbeiro/login', { identificador: a.body.email, senha: a.body.senha }),
      await request(`/publico/assinaturas/${a.id}`, { localizacaoCidade: 'Recife' }, a.token, 'PATCH'),
    ];
    for (const r of responses) { assert.equal(r.status, 200); clean(r.data); assert.ok(!JSON.stringify(r.data).includes('synthetic-private-bridge')); }
    const admin = await request('/admin/login', { email: 'admin@example.test', senha: 'synthetic-admin-password' });
    const listed = await request('/admin/assinaturas', undefined, admin.data.token, 'GET', true);
    assert.equal(listed.status, 200);
    for (const row of listed.data) clean(row);
    assert.equal((await db.getAsync('SELECT whatsapp_bridge_token FROM assinaturas WHERE id=$1', [a.id])).whatsapp_bridge_token, 'synthetic-private-bridge');
  });

  await t.test('cadastro persiste identidade/perfil normalizados e login aceita formatos equivalentes', async () => {
    const c = await create({ establishmentName: '  Studio normalizado  ', email: '  OWNER@Example.Test  ',
      telefone: '+55 (11) 99000-7777', whatsappNumero: '(11) 99000-8888' });
    const row = await db.getAsync('SELECT email,telefone,whatsapp_numero,barbearia_nome,responsavel_nome,state_code,instagram_handle FROM assinaturas WHERE id=$1', [c.id]);
    assert.deepEqual(row, { email: 'owner@example.test', telefone: '11990007777', whatsapp_numero: '11990008888',
      barbearia_nome: 'Studio normalizado', responsavel_nome: 'Ana Teste', state_code: 'PE', instagram_handle: 'studio.teste' });
    for (const identificador of ['owner@example.test', ' OWNER@EXAMPLE.TEST ', '+55 (11) 99000-7777', '11990008888']) {
      assert.equal((await request('/barbeiro/login', { identificador, senha: c.body.senha })).status, 200);
    }
    assert.equal((await request('/publico/assinaturas', signupBody({ telefone: '(11) 99000-7777' }))).status, 409);
    assert.equal((await request('/publico/assinaturas', signupBody({ email: ' OWNER@example.test ' }))).status, 409);
  });

  await t.test('conta antiga com senha curta e identidade não canônica continua autenticando sem migração', async () => {
    const c = await create(); const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync('1234', salt, 64).toString('hex');
    await db.runAsync('UPDATE assinaturas SET email=$1,telefone=$2,senha_hash=$3,senha_salt=$4 WHERE id=$5', ['  OLD@Example.Test  ', '+55 (11) 99000-6666', hash, salt, c.id]);
    for (const identificador of ['old@example.test', '11990006666']) {
      assert.equal((await request('/barbeiro/login', { identificador, senha: '1234' })).status, 200);
    }
    assert.equal((await db.getAsync('SELECT email FROM assinaturas WHERE id=$1', [c.id])).email, '  OLD@Example.Test  ');
    assert.equal((await request('/publico/assinaturas', signupBody({ telefone: '11990006666' }))).status, 409);
  });

  await t.test('senha nova fraca, não textual ou excessiva é recusada sem criar conta', async () => {
    for (const senha of ['1234', '        ', ' 1234567 ', 12345678, {}, 'a'.repeat(129)]) {
      const body = signupBody({ senha }), r = await request('/publico/assinaturas', body);
      assert.equal(r.status, 400);
      assert.equal((await db.getAsync('SELECT count(*)::int AS n FROM assinaturas WHERE email=$1', [body.email])).n, 0);
    }
  });

  await t.test('duplicidade por nome normalizado é revalidada sob lock com identidades distintas', async subtest => {
    const original = db.get, waiting = [];
    subtest.mock.method(db, 'get', function (sql, params, callback) {
      if (!sql.includes('OR btrim(barbearia_nome) = $4')) return original.call(db, sql, params, callback);
      return original.call(db, sql, params, (error, row) => {
        waiting.push(() => callback(error, row));
        if (waiting.length === 2) waiting.forEach(deliver => deliver());
      });
    });
    const results = await Promise.all([1, 2].map(() => request('/publico/assinaturas', signupBody({ establishmentName: '  Nome simultâneo  ' }))));
    assert.deepEqual(results.map(r => r.status).sort(), [201, 409]);
    assert.equal((await db.getAsync("SELECT count(*)::int AS n FROM assinaturas WHERE barbearia_nome='Nome simultâneo'")).n, 1);
    assert.equal(results.find(r => r.status === 409).data.code, 'ASSINATURA_EXISTENTE');
  });

  await t.test('primeiro serviço, criação, edição e configuração legada recusam o mesmo preço inválido', async () => {
    const baseline = await db.getAsync('SELECT preco FROM servicos_assinatura WHERE id=$1', [a.service.id]);
    for (const preco of [1.005, 1.000000001, null, 'NaN', 'Infinity', '1,20', false, '1e2', -1, 100000.01]) {
      assert.equal((await request('/publico/assinaturas', signupBody({ servicos: [{ nome: 'Serviço', preco, duracao: 30 }] }))).status, 400);
      assert.equal((await request('/studiofy/servicos', catalog({ preco }), a.token)).status, 400);
      assert.equal((await edit({ preco })).status, 400);
      assert.equal((await request(`/publico/assinaturas/${a.id}`, { servicos: [{ nome: 'Manicure', preco }] }, a.token, 'PATCH')).status, 400);
      assert.deepEqual(await db.getAsync('SELECT preco FROM servicos_assinatura WHERE id=$1', [a.service.id]), baseline);
    }
    assert.equal((await edit({ preco: '35.20' })).status, 200);
    assert.equal((await request('/studiofy/servicos', catalog({ nome: 'Gratuito', preco: 0 }), a.token)).status, 201);
  });

  await t.test('cadastro e configuração recusam horários impossíveis; solicitação inválida não salva parcialmente', async () => {
    const stored = () => db.getAsync('SELECT horario_abertura,horario_fechamento,localizacao_cidade FROM assinaturas WHERE id=$1', [a.id]);
    const before = await stored();
    for (const extra of [{ horarioAbertura: '25:99' }, { horarioFechamento: '24:00' },
      { horarioAbertura: '18:00', horarioFechamento: '08:00' }, { horarioAlmocoFim: '19:00' }, { diasFuncionamento: ['1x'] }]) {
      assert.equal((await request('/publico/assinaturas', signupBody(extra))).status, 400);
      assert.equal((await request(`/publico/assinaturas/${a.id}`, { ...extra, localizacaoCidade: 'Não salvar' }, a.token, 'PATCH')).status, 400);
      assert.deepEqual(await stored(), before);
    }
    assert.equal((await request(`/publico/assinaturas/${a.id}`, { localizacaoCidade: 'Não salvar', servicos: [{ nome: 'Manicure', preco: 1.005 }] }, a.token, 'PATCH')).status, 400);
    assert.deepEqual(await stored(), before);
    assert.equal((await request('/studiofy/horarios', { horarios: Array.from({ length: 7 }, () => [['25:99', '18:00']]) }, a.token, 'PUT')).status, 400);
    assert.equal((await request('/bloqueios', { data: date, hora: '25:99' }, a.token)).status, 400);
  });

  await t.test('dias vazios permanecem fechados na resposta e na disponibilidade pública', async () => {
    const c = await create({ diasFuncionamento: [] });
    const account = await request(`/publico/assinaturas/${c.id}`, undefined, c.token);
    assert.deepEqual(account.data.dias_funcionamento, []);
    const slots = await request(`/studiofy/public/studio-${c.id}/horarios?` + new URLSearchParams({
      data: date, servico_id: c.service.id, profissional_id: c.professional,
    }));
    assert.deepEqual(slots.data, []);
  });

  await t.test('reserva termina exatamente no fechamento; ultrapassar fechamento é conflito sem linha parcial', async () => {
    await reset(); assert.equal((await request(root + '/agendamentos', booking())).status, 201);
    await reset(); assert.equal((await edit({ duracao: 60 })).status, 200);
    assert.equal((await request(root + '/agendamentos', booking())).status, 409);
    assert.equal((await db.getAsync('SELECT count(*)::int AS n FROM agendamentos WHERE assinatura_id=$1', [a.id])).n, 0);
    assert.equal((await db.getAsync('SELECT count(*)::int AS n FROM public_booking_access')).n, 0);
  });

  await t.test('mudança de duração após consultar slots é revalidada na confirmação', async () => {
    await reset();
    const slots = await request(root + '/horarios?' + new URLSearchParams({ data: date, servico_id: a.service.id, profissional_id: a.professional }));
    assert.ok(slots.data.includes('17:30'));
    assert.equal((await edit({ duracao: 60 })).status, 200);
    assert.equal((await request(root + '/agendamentos', booking({ duracao: 30, preco: 0 }))).status, 409);
  });

  await t.test('preço legado inválido não produz reserva nova incompatível; não reescreve o catálogo', async () => {
    await reset();
    await db.runAsync('UPDATE servicos_assinatura SET preco=$1 WHERE id=$2', [1.000000001, a.service.id]);
    assert.equal((await request(root + '/agendamentos', booking())).status, 409);
    assert.equal((await db.getAsync('SELECT count(*)::int AS n FROM agendamentos WHERE assinatura_id=$1', [a.id])).n, 0);
    assert.equal((await db.getAsync('SELECT preco FROM servicos_assinatura WHERE id=$1', [a.service.id])).preco, 1.000000001);
  });

  await t.test('duas confirmações HTTP simultâneas preservam 201/409 e uma única reserva', async () => {
    await reset();
    const results = await Promise.all([1, 2].map(() => request(root + '/agendamentos', booking())));
    assert.deepEqual(results.map(r => r.status).sort(), [201, 409]);
    assert.equal((await db.getAsync('SELECT count(*)::int AS n FROM agendamentos WHERE assinatura_id=$1', [a.id])).n, 1);
  });

  await t.test('bloqueio após leitura pública é revalidado dentro da transação de confirmação', async subtest => {
    await reset(); const accessBefore=await db.getAsync('SELECT status,status_assinatura,bloqueado,proximo_vencimento,acesso_manual_ate FROM assinaturas WHERE id=$1',[a.id]); const original = db.transaction; let transactions = 0;
    subtest.mock.method(db, 'transaction', async function (callback, options) {
      if (++transactions === 1) await db.runAsync("UPDATE assinaturas SET status='bloqueada',status_assinatura='BLOQUEADA',bloqueado=1,proximo_vencimento=NULL,acesso_manual_ate=NULL WHERE id=$1", [a.id]);
      return original.call(db, callback, options);
    });
    try {
      assert.equal((await request(root + '/agendamentos', booking())).status, 404);
      assert.equal((await db.getAsync('SELECT count(*)::int AS n FROM agendamentos WHERE assinatura_id=$1', [a.id])).n, 0);
    } finally { await db.runAsync('UPDATE assinaturas SET status=$1,status_assinatura=$2,bloqueado=$3,proximo_vencimento=$4,acesso_manual_ate=$5 WHERE id=$6',[...['status','status_assinatura','bloqueado','proximo_vencimento','acesso_manual_ate'].map(field=>accessBefore[field]),a.id]); }
  });

  for (const writer of ['HTTP editor', 'SQL update']) await t.test(`edição concorrente ${writer} espera gravação; reserva conserva a duração validada`, async subtest => {
    await reset(); const original = db.transaction; let reached, release, writingDone = false;
    const ready = new Promise(resolve => { reached = resolve; }), gate = new Promise(resolve => { release = resolve; });
    let paused = false;
    subtest.mock.method(db, 'transaction', function (callback, options) {
      return original.call(db, connection => callback({ ...connection, allAsync: async (sql, ...args) => {
        if (!paused && sql.startsWith('SELECT hora,duracao FROM agendamentos')) { paused = true; reached(); await gate; }
        return connection.allAsync(sql, ...args);
      } }), options);
    });
    try {
      const pendingBooking = request(root + '/agendamentos', booking());
      await ready;
      const pendingEdit = (writer === 'HTTP editor' ? edit({ duracao: 60 }) :
        db.runAsync('UPDATE servicos_assinatura SET duracao=60 WHERE id=$1', [a.service.id]))
        .then(result => { writingDone = true; return result; });
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(writingDone, false, 'Catálogo não muda durante a validação/gravação protegida');
      release(); assert.equal((await pendingBooking).status, 201); await pendingEdit;
      const row = await db.getAsync('SELECT hora,duracao,preco FROM agendamentos WHERE assinatura_id=$1', [a.id]);
      assert.deepEqual(row, { hora: '17:30', duracao: 30, preco: 35.2 });
      assert.equal((await db.getAsync('SELECT duracao FROM servicos_assinatura WHERE id=$1', [a.service.id])).duracao, 60);
    } finally { release(); }
  });

  await t.test('serviço/profissional estrangeiro e tenant/preço/status forjados não atravessam estabelecimento', async () => {
    await reset();
    for (const extra of [{ servico_id: b.service.id }, { profissional_id: b.professional }]) {
      assert.equal((await request(root + '/agendamentos', booking(extra))).status, 409);
    }
    assert.equal((await request(`/studiofy/servicos/${a.service.id}`, catalog({ preco: 0 }), b.token, 'PUT')).status, 404);
    const created = await request(root + '/agendamentos', booking({ assinatura_id: b.id, preco: 0, duracao: 5, status: 'concluido' }));
    assert.equal(created.status, 201);
    const row = await db.getAsync('SELECT assinatura_id,preco,duracao,status FROM agendamentos WHERE assinatura_id=$1', [a.id]);
    assert.deepEqual(row, { assinatura_id: a.id, preco: 35.2, duracao: 30, status: 'confirmado' });
  });

  await t.test('Agenda recebe campos corretos; confirmado não fatura e catálogo não reescreve os snapshots', async () => {
    const panel = (await request('/studiofy/painel', undefined, a.token)).data;
    const row = panel.agendamentos[0];
    assert.equal(row.nome_cliente, 'Cliente Histórico'); assert.equal(row.telefone, '5511999992222');
    assert.equal(row.servico_nome, 'Manicure'); assert.equal(row.profissional_id, a.professional);
    assert.equal(row.data, date); assert.equal(row.hora, '17:30'); assert.equal(row.status, 'confirmado');
    assert.equal(panel.financeiro.total.valor_centavos, 0);
    assert.equal((await request('/studiofy/painel', undefined, b.token)).data.agendamentos.length, 0);
    await edit({ preco: 70, duracao: 60, ativo: false });
    const historical = await db.getAsync('SELECT preco,duracao,servico_nome FROM agendamentos WHERE id=$1', [row.id]);
    assert.deepEqual(historical, { preco: 35.2, duracao: 30, servico_nome: 'Manicure' });
    await db.runAsync("UPDATE agendamentos SET data='2020-01-01',hora='00:00' WHERE id=$1", [row.id]);
    assert.equal((await request(`/studiofy/agendamentos/${row.id}`, { status: 'concluido' }, a.token, 'PATCH')).status, 200);
    assert.equal((await request('/studiofy/painel', undefined, a.token)).data.financeiro.total.valor_centavos, 3520);
  });

  await t.test('cancelamento mantém capacidade individual, hash, estado final e isolamento', async () => {
    await reset(); const created = await request(root + '/agendamentos', booking());
    const token = created.data.token; assert.match(token, /^[a-f0-9]{64}$/);
    const access = await db.getAsync('SELECT token_hash FROM public_booking_access');
    assert.equal(access.token_hash, crypto.createHash('sha256').update(token).digest('hex'));
    assert.notEqual(access.token_hash, token);
    assert.equal((await request('/studiofy/public/reservas/consultar', { token: '00'.repeat(32) })).status, 404);
    assert.equal((await request('/studiofy/public/reservas/cancelar', { token, confirmar: true, assinatura_id: b.id })).status, 200);
    assert.equal((await request('/studiofy/public/reservas/cancelar', { token, confirmar: true })).status, 409);
    assert.equal((await request(root + '/agendamentos', booking({ nome_cliente: 'Nova pessoa' }))).status, 201);
    assert.equal((await request('/studiofy/public/reservas/consultar', { token })).data.nome_cliente, 'Cliente Histórico');
    assert.equal((await request('/studiofy/public/reservas/cancelar', { token, confirmar: true })).status, 409);
    assert.equal((await request('/studiofy/painel', undefined, a.token)).data.financeiro.total.valor_centavos, 0);
  });
});
