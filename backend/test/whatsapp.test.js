const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('WhatsApp: rotas reais, banco isolado e Evolution simulada', async (t) => {
  const testDb = require('./helpers/postgres').testEnvironment();
  process.env.EVOLUTION_API_KEY = 'test-only-key';
  process.env.EVOLUTION_API_RETRY_ATTEMPTS = '1';
  const instances = new Map();
  const calls = [];
  let failure = null;
  let emptyCodes = 0;
  let delayConnect = 0;
  let connectGate = null;
  let connectEntered = null;
  let createConflict = false;
  let uncertainStateOnce = false;
  const mock = express();
  mock.use(express.json());
  mock.use(async (req, res) => {
    calls.push({ at: Date.now(), method: req.method, path: req.path, query: req.query, body: req.body });
    assert.equal(req.headers.apikey, 'test-only-key');
    if (failure && (!failure.path || failure.path === req.path)) return res.status(failure.status).set('Retry-After', failure.retryAfter || '30').json(failure.body);
    const name = req.path.split('/').pop();
    if (req.path === '/instance/fetchInstances') {
      if (req.query.instanceName && !instances.has(req.query.instanceName)) {
        return res.status(404).json({ status: 404, error: 'Not Found', response: { message: [`Instance "${req.query.instanceName}" not found`] } });
      }
      return res.json([...instances.keys()].map((name) => ({ name })));
    }
    if (req.path === '/instance/create') {
      assert.equal(req.body.qrcode, false, 'Criar instancia nao deve iniciar QR antes do pareamento');
      instances.set(req.body.instanceName, { state: 'close' });
      if (createConflict) return res.status(403).json({ response: { message: [`This name ${req.body.instanceName} is already in use.`] } });
      return res.json({ instance: { instanceName: req.body.instanceName } });
    }
    if (req.path.startsWith('/webhook/')) {
      assert.equal(req.body.webhook.enabled, true);
      return res.json({ success: true });
    }
    if (uncertainStateOnce && req.path.startsWith('/instance/connectionState/')) {
      uncertainStateOnce = false;
      return res.json({});
    }
    const instance = instances.get(name);
    if (!instance) return res.status(404).json({ message: 'Instance does not exist' });
    if (req.path.startsWith('/instance/connectionState/')) return res.json({ instance });
    if (req.path.startsWith('/instance/logout/')) { instance.state = 'close'; return res.json({ success: true }); }
    if (req.path.startsWith('/instance/connect/')) {
      if (connectEntered) connectEntered();
      if (connectGate) await connectGate;
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
    await testDb.cleanup();
  });
  await db.ready;
  const salt = 'test-salt';
  const hash = crypto.scryptSync('test-password', salt, 64).toString('hex');
  for (const id of [1, 2]) {
    await db.runAsync(`INSERT INTO assinaturas (id, barbearia_nome, responsavel_nome, telefone, email, metodo_pagamento, dia_vencimento, suporte_numero, status, senha_hash, senha_salt)
      VALUES ($1, 'Teste', 'Teste', $2, $3, 'mercado_pago', 5, '', 'ativo', $4, $5)`, [id, `7599999999${id}`, `test${id}@example.test`, hash, salt]);
  }
  const request = async (route, token, body, method = body ? 'POST' : 'GET') => {
    const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', ...(token ? { 'x-barbeiro-token': token } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, retryAfter: response.headers.get('Retry-After'), body: await response.json() };
  };
  const tokens = [];
  for (const id of [1, 2]) {
    const result = await request('/barbeiro/login', null, { identificador: `test${id}@example.test`, senha: 'test-password' });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    tokens.push(result.body.token);
  }
  const route = '/publico/assinaturas/1/whatsapp';
  const clearCode = id => api.invalidarExistenciaInstancia(`barbearia-${id}`);
  t.beforeEach(() => { clearCode(1); clearCode(2); });

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
    for (const [phone, expected] of [['5575981218107', '5575981218107'], ['75983179933', '5575983179933'], ['+55 (75) 98317-9933', '5575983179933'], ['55983179933', '5555983179933']]) {
      clearCode(1);
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
  await t.test('resposta sem codigo inicia uma unica tentativa e polling apenas consulta estado', async () => {
    instances.get('barbearia-1').state = 'close';
    emptyCodes = 1;
    const before = calls.length;
    const result = await request(route + '/pairing-code', tokens[0], { numero: '55983179933' });
    assert.equal(result.status, 200);
    assert.equal(result.body.pending, true);
    assert.equal(result.body.connectionAttemptActive, true);
    assert.equal(result.body.pairingCode, undefined);
    const afterConnect = calls.length;
    for (let i = 0; i < 3; i++) {
      assert.equal((await request(route + '/status', tokens[0])).body.connectionAttemptActive, true);
    }
    assert.ok(calls.slice(afterConnect).every(call => call.path.includes('/connectionState/')));
    await request(route + '/pairing-code', tokens[0], { numero: '55983179933' });
    assert.equal(calls.slice(before).filter(call => call.path.includes('/connect/')).length, 1);
    assert.equal(calls.filter(call => call.path.includes('/logout/')).length, 0);
  });
  await t.test('codigo gerado bloqueia outro connect mesmo apos 15s e estado close, para pairing e QR', async sub => {
    let now = Date.now();
    sub.mock.method(Date, 'now', () => now);
    for (const mode of ['pairing', 'qr']) {
      clearCode(1);
      instances.set('barbearia-1', { state: 'close' });
      emptyCodes = 0;
      const suffix = mode === 'pairing' ? '/pairing-code' : '/iniciar';
      const body = mode === 'pairing' ? { phone: '75983179933' } : {};
      const before = calls.length;
      const first = await request(route + suffix, tokens[0], body);
      assert.equal(first.status, 200);
      assert.ok(first.body.pairingCode || first.body.qrCode);
      assert.equal(first.body.connectionAttemptActive, true);
      now += 240000;
      instances.get('barbearia-1').state = 'close';
      for (let i = 0; i < 3; i++) {
        const status = await request(route + '/status', tokens[0]);
        assert.equal(status.body.connectionAttemptActive, true);
      }
      const second = await request(route + suffix, tokens[0], body);
      assert.equal(second.body.pending, true);
      assert.equal(calls.slice(before).filter(call => call.path.includes('/connect/')).length, 1);
    }
  });
  await t.test('instancia ja connecting sem cache local nao recebe connect em nenhum metodo', async () => {
    instances.set('barbearia-1', { state: 'connecting' });
    const before = calls.length;
    for (const [suffix, body] of [['/pairing-code', { phone: '75983179933' }], ['/iniciar', {}]]) {
      const result = await request(route + suffix, tokens[0], body);
      assert.equal(result.status, 200);
      assert.equal(result.body.pending, true);
    }
    assert.equal(calls.slice(before).filter(call => call.path.includes('/connect/')).length, 0);
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
    instances.set('timeout-test', { state: 'close' });
    delayConnect = 100;
    await assert.rejects(api.conectarInstancia('timeout-test', '5575983179933', { timeoutMs: 10, retryAttempts: 1 }), { code: 'EVOLUTION_TIMEOUT' });
    delayConnect = 0;
  });
  await t.test('requisicoes simultaneas compartilham tentativa, metodos nao se misturam', async () => {
    instances.set('barbearia-1', { state: 'close' });
    let release;
    connectGate = new Promise(resolve => { release = resolve; });
    const entered = new Promise(resolve => { connectEntered = resolve; });
    const beforeConnect = calls.filter(call => call.path === '/instance/connect/barbearia-1').length;
    const first = request(route + '/pairing-code', tokens[0], { phone: '75983179933' });
    await entered;
    const second = request(route + '/pairing-code', tokens[0], { phone: '75983179933' });
    try {
      const conflict = await request(route + '/iniciar', tokens[0], {});
      assert.equal(conflict.status, 409);
    } finally {
      release();
      connectGate = null;
      connectEntered = null;
    }
    const firstResult = await first;
    const secondResult = await second;
    assert.equal(firstResult.body.code, 'ABCD1234');
    assert.equal(secondResult.status, 200);
    // If its database lookup finishes after the first response, the second
    // request observes an active attempt instead of joining the in-flight job.
    assert.ok(secondResult.body.code === firstResult.body.code || secondResult.body.pending === true);
    assert.equal(secondResult.body.connectionAttemptActive, true);
    assert.equal(calls.filter(call => call.path === '/instance/connect/barbearia-1').length - beforeConnect, 1);
  });
  await t.test('duas requisicoes QR simultaneas iniciam apenas um connect', async () => {
    instances.set('barbearia-1', { state: 'close' });
    let release;
    connectGate = new Promise(resolve => { release = resolve; });
    const entered = new Promise(resolve => { connectEntered = resolve; });
    const before = calls.length;
    const first = request(route + '/iniciar', tokens[0], {});
    await entered;
    const second = request(route + '/iniciar', tokens[0], {});
    release();
    connectGate = null;
    connectEntered = null;
    const results = await Promise.all([first, second]);
    assert.ok(results.every(result => result.status === 200 && result.body.connectionAttemptActive));
    assert.equal(calls.slice(before).filter(call => call.path.includes('/connect/')).length, 1);
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
  await t.test('logout de instancia ja desconectada na Evolution 2.3.7 e idempotente', async () => {
    failure = { path: '/instance/logout/barbearia-1', status: 400, body: { message: 'The barbearia-1 instance is not connected' } };
    assert.equal((await request(route + '/logout', tokens[0], null, 'DELETE')).status, 200);
    failure = null;
  });
  await t.test('reconectar reutiliza a instancia apos logout', async () => {
    const before = calls.filter((call) => call.path === '/instance/create').length;
    const result = await request(route + '/pairing-code', tokens[0], { phone: '5575981218107' });
    assert.equal(result.status, 200);
    assert.equal(result.body.pairingCode, 'ABCD1234');
    assert.equal(calls.filter((call) => call.path === '/instance/create').length, before);
  });
  await t.test('QR sem codigo permanece pendente sem repetir connect e preserva erros HTTP', async () => {
    instances.get('barbearia-2').state = 'close';
    emptyCodes = 1;
    const before = calls.length;
    const qrRoute = '/publico/assinaturas/2/whatsapp/iniciar';
    const pending = await request(qrRoute, tokens[1], {});
    assert.equal(pending.status, 200);
    assert.equal(pending.body.pending, true);
    await request(qrRoute, tokens[1], {});
    assert.equal(calls.slice(before).filter(call => call.path.includes('/connect/')).length, 1);
    failure = { status: 401, body: '<html>Unauthorized</html>' };
    const result = await request(qrRoute, tokens[1], {});
    assert.equal(result.status, 502);
    assert.equal(result.body.errorCode, 'EVOLUTION_INVALID_KEY');
    failure = null;
  });
  await t.test('conflito 403 de criacao confirma instancia e reutiliza', async () => {
    instances.delete('barbearia-2');
    createConflict = true;
    const before = calls.filter((call) => call.path === '/instance/fetchInstances').length;
    const result = await request('/publico/assinaturas/2/whatsapp/pairing-code', tokens[1], { phone: '5575981218107' });
    createConflict = false;
    assert.equal(result.status, 200);
    assert.equal(result.body.pairingCode, 'ABCD1234');
    assert.equal(calls.filter((call) => call.path === '/instance/fetchInstances').length - before, 1);
  });
  await t.test('falha de criacao identifica a etapa sem expor detalhes', async () => {
    instances.delete('barbearia-2');
    failure = { path: '/instance/create', status: 400, body: { message: 'internal database error' } };
    const result = await request('/publico/assinaturas/2/whatsapp/pairing-code', tokens[1], { phone: '5575981218107' });
    assert.equal(result.status, 502);
    assert.equal(result.body.errorCode, 'EVOLUTION_CREATE_FAILED');
    assert.doesNotMatch(JSON.stringify(result.body), /database/);
    failure = null;
  });
  await t.test('ausencia de codigo informa pendencia sem afirmar que gerou codigo', async () => {
    instances.get('barbearia-1').state = 'close';
    emptyCodes = 2;
    const before = calls.length;
    const result = await request(route + '/pairing-code', tokens[0], { phone: '75983179933' });
    assert.equal(result.status, 200);
    assert.equal(result.body.pending, true);
    assert.equal(result.body.pairingCode, undefined);
    assert.equal(result.body.status, 'pairing');
    assert.equal(calls.slice(before).filter(call => call.path.includes('/connect/')).length, 1);
    assert.equal(calls.filter((call) => call.path.includes('/logout/')).length, 2);
  });
  await t.test('contagem exata de chamadas: existente, nova e conectada', async () => {
    for (const scenario of ['existing', 'new', 'connected']) {
      clearCode(1);
      emptyCodes = 0;
      if (scenario === 'new') instances.delete('barbearia-1');
      else instances.set('barbearia-1', { state: scenario === 'connected' ? 'open' : 'close' });
      const before = calls.length;
      const result = await request(route + '/pairing-code', tokens[0], { phone: '75983179933' });
      assert.equal(result.status, 200);
      await new Promise(resolve => setTimeout(resolve, 30)); // webhook disparado apos o codigo
      const paths = calls.slice(before).map(call => call.path);
      const expected = ['/instance/connectionState/barbearia-1'];
      if (scenario === 'new') expected.push('/instance/create', '/instance/connectionState/barbearia-1');
      if (scenario !== 'connected') expected.push('/instance/connect/barbearia-1', '/webhook/set/barbearia-1');
      assert.deepEqual(paths, expected);
    }
  });
  await t.test('QR em instancia existente nao busca instancias; open/connected nao geram codigo', async () => {
    for (const state of ['close', 'open', 'connected', 'CONNECTED']) {
      clearCode(2);
      instances.set('barbearia-2', { state });
      const before = calls.length;
      const result = await request('/publico/assinaturas/2/whatsapp/iniciar', tokens[1], {});
      assert.equal(result.status, 200);
      const paths = calls.slice(before).map(call => call.path).filter(path => !path.startsWith('/webhook/'));
      assert.deepEqual(paths, state === 'close'
        ? ['/instance/connectionState/barbearia-2', '/instance/connect/barbearia-2']
        : ['/instance/connectionState/barbearia-2']);
      if (state !== 'close') assert.equal(result.body.conectado, true);
      await new Promise(resolve => setTimeout(resolve, 30));
    }
  });
  await t.test('estado incerto usa busca excepcional; existencia em cache evita repetir busca', async () => {
    instances.set('barbearia-1', { state: 'close' });
    for (const expectedSearches of [1, 0]) {
      uncertainStateOnce = true;
      const before = calls.length;
      const result = await request(route + '/pairing-code', tokens[0], { phone: '75983179933' });
      assert.equal(result.body.errorCode, 'EVOLUTION_STATE_UNKNOWN');
      const paths = calls.slice(before).map(call => call.path);
      assert.equal(paths.filter(path => path === '/instance/fetchInstances').length, expectedSearches);
      assert.equal(paths.filter(path => path === '/instance/create' || path.includes('/connect/')).length, 0);
    }
  });
  await t.test('404 generico de rota nao e ausencia: consulta excepcional sem criar', async () => {
    instances.set('barbearia-1', { state: 'close' });
    failure = { path: '/instance/connectionState/barbearia-1', status: 404,
      body: { path: '/instance/connectionState/barbearia-1', message: 'Not Found' } };
    const before = calls.length;
    try {
      const result = await request(route + '/pairing-code', tokens[0], { phone: '75983179933' });
      assert.equal(result.body.errorCode, 'EVOLUTION_ENDPOINT_NOT_FOUND');
      assert.deepEqual(calls.slice(before).map(call => call.path), ['/instance/connectionState/barbearia-1', '/instance/fetchInstances']);
    } finally { failure = null; }
  });
  await t.test('estado incerto e busca confirma ausencia: cria uma vez e consulta estado novamente', async () => {
    instances.delete('barbearia-1');
    uncertainStateOnce = true;
    const before = calls.length;
    const result = await request(route + '/pairing-code', tokens[0], { phone: '75983179933' });
    assert.equal(result.status, 200);
    const paths = calls.slice(before).map(call => call.path).filter(path => !path.startsWith('/webhook/'));
    assert.deepEqual(paths, ['/instance/connectionState/barbearia-1', '/instance/fetchInstances', '/instance/create', '/instance/connectionState/barbearia-1', '/instance/connect/barbearia-1']);
    await new Promise(resolve => setTimeout(resolve, 30));
  });
  await t.test('401, 403 e 5xx de estado nao buscam nem criam instancia', async () => {
    for (const status of [401, 403, 500, 502, 503, 504]) {
      failure = { path: '/instance/connectionState/barbearia-1', status, body: { message: 'Instance not found' } };
      const before = calls.length;
      const result = await request(route + '/pairing-code', tokens[0], { phone: '75983179933' });
      assert.ok(result.status >= 400);
      assert.deepEqual(calls.slice(before).map(call => call.path), ['/instance/connectionState/barbearia-1']);
    }
    failure = null;
  });
  await t.test('timeout e erro de rede de estado interrompem sem busca ou criacao', async sub => {
    const nativeFetch = global.fetch;
    let simulated;
    sub.mock.method(global, 'fetch', (url, options) => {
      if (String(url).startsWith(process.env.EVOLUTION_API_URL + '/instance/connectionState/')) return Promise.reject(simulated);
      return nativeFetch(url, options);
    });
    for (const error of [new DOMException('Timeout', 'AbortError'), new TypeError('fetch failed')]) {
      simulated = error;
      const before = calls.length;
      const result = await request(route + '/pairing-code', tokens[0], { phone: '75983179933' });
      assert.ok(['EVOLUTION_TIMEOUT', 'EVOLUTION_OFFLINE'].includes(result.body.errorCode));
      assert.equal(calls.length, before);
    }
  });
  await t.test('conflito de criacao com confirmacao negada nao conecta nem repete criacao', async () => {
    instances.delete('barbearia-2');
    createConflict = true;
    failure = { path: '/instance/fetchInstances', status: 401, body: { message: 'Unauthorized' } };
    const before = calls.length;
    try {
      const result = await request('/publico/assinaturas/2/whatsapp/pairing-code', tokens[1], { phone: '75983179933' });
      assert.equal(result.body.errorCode, 'EVOLUTION_INVALID_KEY');
      assert.deepEqual(calls.slice(before).map(call => call.path), ['/instance/connectionState/barbearia-2', '/instance/create', '/instance/fetchInstances']);
    } finally { createConflict = false; failure = null; }
  });
  await t.test('GETs de QR antigos consultam somente estado, antes e durante tentativa', async () => {
    instances.set('barbearia-1', { state: 'close' });
    const paths = [route + '/qr', '/whatsapp/qr'];
    for (const state of ['close', 'connecting', 'open']) {
      instances.get('barbearia-1').state = state;
      const before = calls.length;
      for (const path of paths) {
        const result = await request(path, tokens[0]);
        assert.equal(result.status, 200);
      }
      assert.ok(calls.slice(before).every(call => call.path === '/instance/connectionState/barbearia-1'));
      assert.equal(calls.length - before, 2);
    }
  });
  await t.test('429 nas rotas preserva prazo e bloqueia pairing, QR e status sem acessar Evolution', async () => {
    instances.set('barbearia-1', { state: 'close' });
    failure = { path: '/instance/connectionState/barbearia-1', status: 429, retryAfter: '120', body: { message: 'Too Many Requests' } };
    const initial = calls.length;
    const result = await request(route + '/pairing-code', tokens[0], { phone: '75983179933' });
    assert.deepEqual(calls.slice(initial).map(call => call.path), ['/instance/connectionState/barbearia-1']);
    assert.equal(result.status, 429);
    assert.equal(result.retryAfter, '120');
    assert.equal(result.body.retryAfterSeconds, 120);
    assert.equal(result.body.errorCode, 'EVOLUTION_RATE_LIMIT');
    assert.equal(result.body.rateLimitSource, 'upstream');
    assert.equal(result.body.upstreamStatus, 429);
    const before = calls.length;
    for (const [suffix, body] of [['/pairing-code', { phone: '75983179933' }], ['/iniciar', {}], ['/status', undefined], ['/qr', undefined]]) {
      const blocked = await request(route + suffix, tokens[0], body);
      assert.equal(blocked.status, 429);
      assert.equal(blocked.body.rateLimitSource, 'local_cooldown');
      assert.equal(blocked.body.upstreamStatus, undefined);
      assert.ok(Number(blocked.retryAfter) > 0);
    }
    const legacy = await request('/whatsapp/qr', tokens[0]);
    assert.equal(legacy.status, 429);
    assert.equal(legacy.body.rateLimitSource, 'local_cooldown');
    assert.equal(calls.length, before);
    failure = null;
  });
  await t.test('falha SQL produz JSON 500 sem expor detalhes internos', async (subtest) => {
    subtest.mock.method(db, 'get', (sql, params, callback) => callback(Object.assign(new Error('XX000: simulated failure'), { code: 'XX000' })));
    const result = await request(route + '/status', tokens[0]);
    assert.equal(result.status, 500);
    assert.equal(result.body.status, 'error');
    assert.match(result.body.message, /Erro interno/);
    assert.doesNotMatch(result.body.message, /SQLITE/);
  });
});
