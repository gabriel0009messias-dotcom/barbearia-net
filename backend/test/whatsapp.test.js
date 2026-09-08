const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('WhatsApp: rotas reais, banco isolado e Evolution simulada', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'barbearia-whatsapp-'));
  process.env.DATABASE_PATH = path.join(directory, 'test.db');
  fs.writeFileSync(process.env.DATABASE_PATH, ''); // Impede importacao automatica do banco legado.
  process.env.EVOLUTION_API_KEY = 'test-only-key';
  process.env.EVOLUTION_API_RETRY_ATTEMPTS = '1';
  const instances = new Map();
  const calls = [];
  let failure = null;
  let emptyCodes = 0;
  let delayConnect = 0;
  const mock = express();
  mock.use(express.json());
  mock.use(async (req, res) => {
    calls.push({ method: req.method, path: req.path, query: req.query, body: req.body });
    if (failure) return res.status(failure.status).json(failure.body);
    const name = req.path.split('/').pop();
    if (req.path === '/instance/fetchInstances') {
      return res.json([...instances.keys()].map((name) => ({ name })));
    }
    if (req.path === '/instance/create') {
      assert.equal(req.body.qrcode, false, 'Criar instancia nao deve iniciar QR antes do pareamento');
      instances.set(req.body.instanceName, { state: 'close' });
      return res.json({ instance: { instanceName: req.body.instanceName } });
    }
    if (req.path.startsWith('/webhook/')) {
      assert.equal(req.body.webhook.enabled, true);
      return res.json({ success: true });
    }
    const instance = instances.get(name);
    if (!instance) return res.status(404).json({ message: 'Instance does not exist' });
    if (req.path.startsWith('/instance/connectionState/')) return res.json({ instance });
    if (req.path.startsWith('/instance/logout/')) { instance.state = 'close'; return res.json({ success: true }); }
    if (req.path.startsWith('/instance/connect/')) {
      if (delayConnect) await new Promise((resolve) => setTimeout(resolve, delayConnect));
      instance.state = 'connecting';
      if (emptyCodes-- > 0) return res.json({ count: 0 });
      return res.json(req.query.number ? { pairingCode: 'ABCD1234' } : { base64: 'data:image/png;base64,test' });
    }
    res.sendStatus(404);
  });
  const mockServer = await new Promise((resolve) => { const server = mock.listen(0, '127.0.0.1', () => resolve(server)); });
  process.env.EVOLUTION_API_URL = `http://127.0.0.1:${mockServer.address().port}`;
  process.env.PUBLIC_APP_URL = 'https://example.test'; // Reproduz o ReferenceError que so ocorria no Render.
  const router = require('../routes');
  const db = require('../database');
  const api = require('../evolutionApi');
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  const server = await new Promise((resolve) => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  t.after(async () => {
    await Promise.all([new Promise((resolve) => server.close(resolve)), new Promise((resolve) => mockServer.close(resolve))]);
    await new Promise((resolve) => db.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await db.ready;
  const salt = 'test-salt';
  const hash = crypto.scryptSync('test-password', salt, 64).toString('hex');
  for (const id of [1, 2]) {
    await db.runAsync(`INSERT INTO assinaturas (id, barbearia_nome, responsavel_nome, telefone, email, metodo_pagamento, dia_vencimento, suporte_numero, status, senha_hash, senha_salt)
      VALUES (?, 'Teste', 'Teste', ?, ?, 'mercado_pago', 5, '', 'ativo', ?, ?)`, [id, `7599999999${id}`, `test${id}@example.test`, hash, salt]);
  }
  const request = async (route, token, body, method = body ? 'POST' : 'GET') => {
    const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', ...(token ? { 'x-barbeiro-token': token } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  const tokens = [];
  for (const id of [1, 2]) {
    const result = await request('/barbeiro/login', null, { identificador: `test${id}@example.test`, senha: 'test-password' });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    tokens.push(result.body.token);
  }
  const route = '/publico/assinaturas/1/whatsapp';

  await t.test('login obrigatorio e isolamento entre assinaturas', async () => {
    assert.equal((await request(route + '/status')).status, 401);
    assert.equal((await request(route + '/status', tokens[1])).status, 403);
    assert.equal((await request(route + '/pairing-code', tokens[1], { phone: '75983179933' })).status, 403);
    assert.equal(calls.length, 0);
  });
  await t.test('sem sessao retorna disconnected sem chamar Evolution', async () => {
    const result = await request(route + '/status', tokens[0]);
    assert.equal(result.body.status, 'disconnected');
    assert.equal(result.body.connected, false);
    assert.equal(result.body.success, true);
    assert.equal(calls.length, 0);
  });
  await t.test('validacao e normalizacao inclusive DDD 55', async () => {
    for (const phone of ['', '123', '55123', '5500983179933']) {
      assert.equal((await request(route + '/pairing-code', tokens[0], { phone })).status, 400);
    }
    for (const [phone, expected] of [['75983179933', '5575983179933'], ['+55 (75) 98317-9933', '5575983179933'], ['55983179933', '5555983179933']]) {
      if (instances.has('barbearia-1')) instances.get('barbearia-1').state = 'close';
      const result = await request(route + '/pairing-code', tokens[0], { phone });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(result.body.code, 'ABCD1234');
      assert.equal(result.body.status, 'pairing_code');
      assert.equal(calls.filter((call) => call.path.includes('/connect/')).at(-1).query.number, expected);
      assert.equal((await db.getAsync('SELECT whatsapp_numero FROM assinaturas WHERE id = 1')).whatsapp_numero, expected);
    }
    assert.equal(calls.filter((call) => call.path === '/instance/create').length, 1);
    assert.equal(calls.filter((call) => call.path.includes('/logout/')).length, 0);
  });
  await t.test('codigo atrasado e sessao connecting nunca provocam logout', async () => {
    emptyCodes = 1;
    const result = await request(route + '/pairing-code', tokens[0], { numero: '55983179933' });
    assert.equal(result.status, 200);
    assert.equal(result.body.pairingCode, 'ABCD1234');
    assert.equal(calls.filter((call) => call.path.includes('/logout/')).length, 0);
    assert.equal((await request(route + '/status', tokens[0])).body.status, 'pairing');
  });
  await t.test('conectado nao cria instancia, nao pede outro codigo e preserva sessao', async () => {
    instances.get('barbearia-1').state = 'open';
    const count = calls.filter((call) => call.path.includes('/connect/')).length;
    const result = await request(route + '/pairing-code', tokens[0], { phone: '75983179933' });
    assert.equal(result.body.connected, true);
    assert.equal(result.body.code, null);
    assert.equal(calls.filter((call) => call.path.includes('/connect/')).length, count);
    assert.equal((await request(route + '/status', tokens[0])).body.status, 'connected');
  });
  await t.test('sessao ausente na Evolution nao derruba status', async () => {
    instances.delete('barbearia-1');
    const result = await request(route + '/status', tokens[0]);
    assert.equal(result.status, 200);
    assert.equal(result.body.status, 'disconnected');
  });
  await t.test('chave invalida da Evolution nao vira login expirado do salao', async () => {
    await db.runAsync("UPDATE assinaturas SET whatsapp_session = 'barbearia-1' WHERE id = 1");
    failure = { status: 401, body: { message: 'Unauthorized invalid apikey' } };
    const result = await request(route + '/status', tokens[0]);
    assert.equal(result.status, 502);
    assert.equal(result.body.success, false);
    assert.match(result.body.message, /chave/i);
    failure = null;
  });
  await t.test('variavel ausente gera mensagem explicita', async () => {
    const key = process.env.EVOLUTION_API_KEY;
    process.env.EVOLUTION_API_KEY = '';
    const result = await request(route + '/pairing-code', tokens[0], { phone: '75983179933' });
    process.env.EVOLUTION_API_KEY = key;
    assert.equal(result.status, 503);
    assert.match(result.body.message, /EVOLUTION_API_KEY/);
  });
  await t.test('timeout aborta a chamada da Evolution', async () => {
    instances.set('barbearia-1', { state: 'close' });
    delayConnect = 100;
    await assert.rejects(api.conectarInstancia('barbearia-1', '5575983179933', { timeoutMs: 10, retryAttempts: 1 }), { code: 'EVOLUTION_TIMEOUT' });
    delayConnect = 0;
  });
  await t.test('requisicoes simultaneas compartilham resultado, metodos nao se misturam', async () => {
    instances.get('barbearia-1').state = 'close';
    delayConnect = 150;
    const first = request(route + '/pairing-code', tokens[0], { phone: '75983179933' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const second = request(route + '/pairing-code', tokens[0], { phone: '75983179933' });
    const conflict = await request(route + '/iniciar', tokens[0], {});
    assert.equal(conflict.status, 409);
    assert.equal((await first).body.code, (await second).body.code);
    delayConnect = 0;
  });
  await t.test('cada cliente tem sua instancia; QR e desconexao explicita funcionam', async () => {
    const result = await request('/publico/assinaturas/2/whatsapp/iniciar', tokens[1], {});
    assert.equal(result.status, 200);
    assert.ok(result.body.qrCode);
    assert.ok(instances.has('barbearia-2'));
    assert.equal((await db.getAsync('SELECT whatsapp_session FROM assinaturas WHERE id = 2')).whatsapp_session, 'barbearia-2');
    const logout = await request(route + '/logout', tokens[0], null, 'DELETE');
    assert.equal(logout.status, 200);
    assert.equal(instances.get('barbearia-1').state, 'close');
  });
  await t.test('ausencia de codigo termina com erro util, sem sucesso falso', async () => {
    emptyCodes = 6;
    const result = await request(route + '/pairing-code', tokens[0], { phone: '75983179933' });
    assert.equal(result.status, 503);
    assert.equal(result.body.success, false);
    assert.equal(result.body.errorCode, 'EVOLUTION_PAIRING_CODE_EMPTY');
    assert.equal(calls.filter((call) => call.path.includes('/logout/')).length, 1);
  });
  await t.test('falha SQL produz JSON 500 sem expor detalhes internos', async (subtest) => {
    subtest.mock.method(db, 'get', (sql, params, callback) => callback(Object.assign(new Error('SQLITE_ERROR: simulated failure'), { code: 'SQLITE_ERROR' })));
    const result = await request(route + '/status', tokens[0]);
    assert.equal(result.status, 500);
    assert.equal(result.body.status, 'error');
    assert.match(result.body.message, /Erro interno/);
    assert.doesNotMatch(result.body.message, /SQLITE/);
  });
});
