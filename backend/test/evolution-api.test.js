const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const api = require('../evolutionApi');
const { logEvolution } = require('../evolutionLog');

test('Evolution: transporte, diagnostico e protecao de segredos', async (t) => {
  const previous = { ...process.env };
  const logs = [];
  t.mock.method(console, 'info', (...args) => logs.push(args.join(' ')));
  t.mock.method(console, 'error', (...args) => logs.push(args.join(' ')));
  let handler;
  let calls = 0;
  const server = http.createServer((req, res) => {
    calls++;
    assert.equal(req.headers.apikey, 'secret-global-key');
    handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.EVOLUTION_API_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.EVOLUTION_API_KEY = 'secret-global-key';
  t.after(async () => {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const reply = (status, body) => { handler = (_, res) => { res.writeHead(status); res.end(typeof body === 'string' ? body : JSON.stringify(body)); }; };

  await t.test('status HTTP prevalece sobre HTML ou mensagem do provedor', async () => {
    for (const [status, code] of [[401, 'EVOLUTION_INVALID_KEY'], [403, 'EVOLUTION_INVALID_KEY'], [503, 'EVOLUTION_OFFLINE'], [504, 'EVOLUTION_TIMEOUT'], [404, 'EVOLUTION_ENDPOINT_NOT_FOUND']]) {
      reply(status, '<html>proxy unavailable</html>');
      await assert.rejects(api.obterEstadoConexao('barbearia-1'), (error) => error.code === code && error.upstreamStatus === status);
    }
  });
  await t.test('falhas de criacao e connect nao vazam mensagem tecnica para o painel', async () => {
    reply(400, { message: 'database password=other-secret apikey=secret-global-key' });
    await assert.rejects(api.criarInstancia('barbearia-1'), { code: 'EVOLUTION_CREATE_FAILED', message: 'Nao foi possivel criar a instancia.' });
    reply(200, { error: true, message: 'internal socket failure token=other-secret' });
    await assert.rejects(api.conectarInstancia('barbearia-1'), { code: 'EVOLUTION_CONNECT_FAILED' });
  });
  await t.test('resposta invalida nao vira lista vazia nem cria outra instancia', async () => {
    reply(200, '<html>Render loading</html>');
    await assert.rejects(api.buscarInstancia('barbearia-1'), { code: 'EVOLUTION_INVALID_RESPONSE' });
    reply(200, { unexpected: true });
    await assert.rejects(api.buscarInstancia('barbearia-1'), { code: 'EVOLUTION_INVALID_RESPONSE' });
  });
  await t.test('conflito de criacao permanece distinguivel', async () => {
    reply(403, { message: 'Forbidden' });
    await assert.rejects(api.criarInstancia('barbearia-1'), { code: 'EVOLUTION_INVALID_KEY' });
    reply(409, { message: 'Conflict' });
    await assert.rejects(api.criarInstancia('barbearia-1'), { code: 'EVOLUTION_INSTANCE_EXISTS' });
    reply(403, { response: { message: ['This name "barbearia-1" is already in use.'] } });
    await assert.rejects(api.criarInstancia('barbearia-1'), { code: 'EVOLUTION_INSTANCE_EXISTS' });
  });
  await t.test('timeout durante leitura preserva causa e nao repete POST', async () => {
    handler = (_, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{'); };
    const before = calls;
    await assert.rejects(api.criarInstancia('barbearia-1', '', { timeoutMs: 30, retryAttempts: 3 }), (error) => error.code === 'EVOLUTION_TIMEOUT' && error.cause?.name === 'AbortError');
    assert.equal(calls - before, 1);
  });
  await t.test('logs preservam evidencias e ocultam segredos, QR e pairing', async () => {
    reply(200, { pairingCode: 'ABCD1234', code: 'raw-qr-secret', base64: 'qr-image-secret', hash: 'instance-secret', token: 'session-secret', nested: { password: 'password-secret' } });
    assert.equal((await api.conectarInstancia('barbearia-1', '5575981218107')).pairingCode, 'ABCD1234');
    logEvolution('test_error', { error: Object.assign(new Error('apikey=secret-global-key'), { cause: new Error('password=other-secret') }) });
    const output = logs.join('\n');
    for (const secret of ['secret-global-key', 'other-secret', 'ABCD1234', 'raw-qr-secret', 'qr-image-secret', 'instance-secret', 'session-secret', 'password-secret', '5575981218107']) assert.ok(!output.includes(secret), secret);
    for (const field of ['request_start', 'request_response', 'request_failure', 'durationMs', 'httpStatus', 'stack', 'cause', 'barbearia-1']) assert.ok(output.includes(field), field);
  });
  await t.test('DNS, conexao recusada e TLS preservam causa tecnica', async (sub) => {
    let networkCode;
    sub.mock.method(global, 'fetch', async () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('network detail'), { code: networkCode }) }); });
    for (networkCode of ['ENOTFOUND', 'ECONNREFUSED', 'CERT_HAS_EXPIRED']) {
      await assert.rejects(api.obterEstadoConexao('barbearia-1'), (error) => error.cause?.cause?.code === networkCode && error.code === (networkCode === 'ENOTFOUND' ? 'EVOLUTION_DNS_ERROR' : 'EVOLUTION_OFFLINE'));
    }
  });
  await t.test('URL invalida e valor de timeout explicito sao respeitados', () => {
    process.env.EVOLUTION_API_TIMEOUT_MS = '5000';
    assert.equal(api.getEvolutionConfig().timeoutMs, 5000);
    process.env.EVOLUTION_API_URL = 'https://example.test/manager';
    assert.throws(api.ensureEvolutionConfigured, { code: 'EVOLUTION_INVALID_URL' });
  });
  assert.equal(api.extrairConteudoQr({ code: 'raw', base64: 'data:image/png;base64,local' }), 'data:image/png;base64,local');
});
