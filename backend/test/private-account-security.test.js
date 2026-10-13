const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

test('Conta privada: autenticação segura e no-store antes de qualquer resposta', { timeout: 60000 }, async t => {
  const environment = require('./helpers/postgres').testEnvironment();
  Object.assign(process.env, { EVOLUTION_API_URL: '', EVOLUTION_API_KEY: '',
    MERCADO_PAGO_ACCESS_TOKEN: '', MERCADO_PAGO_WEBHOOK_SECRET: '' });
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
    await environment.cleanup();
  });
  const request = async (route, token, body, extraHeaders = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api${route}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json',
        ...(token ? { 'x-barbeiro-token': token } : {}), ...extraHeaders },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, cache: response.headers.get('cache-control'),
      body: await response.json() };
  };
  const fixture = { establishmentName: 'Studio Fictício de Teste', responsavelNome: 'Pessoa Fictícia',
    businessType: 'other', city: 'Cidade Fictícia', state: 'SP', telefone: '11980001234',
    email: 'private-account@example.test', senha: 'synthetic-password',
    metodoPagamento: 'mercado_pago', diaVencimento: 5,
    servicos: [{ nome: 'Serviço Fictício', preco: 40, duracao: 30 }] };
  const signup = await request('/publico/assinaturas', undefined, fixture);
  assert.equal(signup.status, 201);
  const id = signup.body.assinatura.id;
  const login = await request('/barbeiro/login', undefined,
    { identificador: fixture.email, senha: fixture.senha });
  assert.equal(login.status, 200);
  const token = login.body.token;
  const routes = ['/studiofy/painel', '/barbeiro/me'];

  for (const route of routes) {
    await t.test(`${route}: sucesso autenticado mantém no-store e dados próprios`, async () => {
      const result = await request(route, token);
      assert.equal(result.status, 200);
      assert.equal(result.cache, 'no-store');
      assert.equal(route === '/studiofy/painel' ? result.body.pagina.nome : result.body.id,
        route === '/studiofy/painel' ? fixture.establishmentName : id);
      const serialized = JSON.stringify(result.body);
      for (const secret of [fixture.senha, token, 'senha_hash', 'senha_salt']) {
        assert.equal(serialized.includes(secret), false);
      }
    });
    for (const invalidToken of [undefined, 'synthetic-invalid-token']) {
      await t.test(`${route}: ${invalidToken ? 'token inválido' : 'sem login'} permanece 401 e no-store`, async () => {
        const result = await request(route, invalidToken);
        assert.equal(result.status, 401);
        assert.equal(result.cache, 'no-store');
        assert.deepEqual(Object.keys(result.body), ['error']);
        assert.equal(result.body.pagina, undefined);
      });
    }
    await t.test(`${route}: falha de banco na autenticação é 500 genérico, no-store e sem logs sensíveis`, async sub => {
      const logs = [];
      for (const method of ['error', 'warn', 'info', 'log', 'debug']) {
        sub.mock.method(console, method, (...args) => logs.push(args));
      }
      const markers = ['synthetic-private-database-detail', 'synthetic-sql-table',
        'synthetic-column', 'synthetic-host', 'synthetic-connection', 'synthetic-stack',
        'synthetic-cookie', 'synthetic-authorization', 'synthetic-sensitive-body', fixture.senha, token];
      const error = Object.assign(new Error(markers.join(' ')), {
        stack: 'synthetic-stack', sql: 'SELECT synthetic-column FROM synthetic-sql-table',
        body: { senha: fixture.senha, token, sensitive: 'synthetic-sensitive-body' },
        headers: { Cookie: 'synthetic-cookie', Authorization: 'synthetic-authorization' },
      });
      sub.mock.method(db, 'get', (_sql, _params, callback) => callback(error));
      const result = await request(route, token, undefined,
        { Cookie: 'synthetic-cookie', Authorization: 'synthetic-authorization' });
      assert.equal(result.status, 500);
      assert.equal(result.cache, 'no-store');
      assert.deepEqual(result.body, { error: 'Não foi possível concluir a solicitação.' });
      const serialized = JSON.stringify({ body: result.body, logs });
      for (const marker of markers) assert.equal(serialized.includes(marker), false, marker);
      assert.equal(logs.some(args => args.some(value => value === error)), false);
    });
  }

  for (const route of routes) {
    await t.test(`${route}: falha após autenticação também é 500 seguro e no-store`, async sub => {
      if (route === '/studiofy/painel') {
        sub.mock.method(db, 'transaction', async () => { throw Error('synthetic-handler-sql-detail'); });
      } else {
        sub.mock.method(db, 'all', (_sql, _params, callback) => callback(Error('synthetic-handler-sql-detail')));
      }
      const result = await request(route, token);
      assert.equal(result.status, 500);
      assert.equal(result.cache, 'no-store');
      assert.deepEqual(result.body, { error: 'Não foi possível concluir a solicitação.' });
    });
  }

  await t.test('conta bloqueada: painel continua 403/no-store e consulta de conta continua 200/no-store', async () => {
    await db.runAsync("UPDATE assinaturas SET bloqueado=1,status='atrasada' WHERE id=$1", [id]);
    try {
      const panel = await request('/studiofy/painel', token);
      assert.equal(panel.status, 403);
      assert.equal(panel.cache, 'no-store');
      assert.equal(panel.body.pagina, undefined);
      const account = await request('/barbeiro/me', token);
      assert.equal(account.status, 200);
      assert.equal(account.cache, 'no-store');
      assert.equal(account.body.id, id);
    } finally {
      await db.runAsync("UPDATE assinaturas SET bloqueado=0,status='pendente' WHERE id=$1", [id]);
    }
  });
  await t.test('conta removida: sessão antiga não dá acesso e retorna 401/no-store nas duas rotas', async () => {
    await db.runAsync('DELETE FROM assinaturas WHERE id=$1', [id]);
    for (const route of routes) {
      const result = await request(route, token);
      assert.equal(result.status, 401);
      assert.equal(result.cache, 'no-store');
    }
  });
});

// These statuses are not all emitted by today's panel handler. Verify that the
// guard remains in front of auth if auth gains another rejection path later.
for (const status of [401, 403, 404, 409, 429, 500]) {
  test(`Painel: no-store já está presente quando autenticação responde ${status}`, async t => {
    const app = express();
    app.use('/studiofy', require('../studiofyRoutes')({}, (_req, res) => {
      assert.equal(res.get('Cache-Control'), 'no-store');
      res.status(status).json({ error: status >= 500 ? 'synthetic-internal-error' : 'Recusa de teste.' });
    }, async () => ({ liberado: true })));
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(async () => {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    });
    const response = await fetch(`http://127.0.0.1:${server.address().port}/studiofy/painel`);
    assert.equal(response.status, status);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(JSON.stringify(await response.json()).includes('synthetic-internal-error'), false);
  });
}
