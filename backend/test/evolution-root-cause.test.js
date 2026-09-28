const { test } = require('node:test');
const assert = require('node:assert/strict');
const api = require('../evolutionApi');

test('404 oficial da Evolution 2.3.7 distingue instancia ausente de rota inexistente', async t => {
  process.env.EVOLUTION_API_URL = 'https://evolution-237.test';
  process.env.EVOLUTION_API_KEY = 'synthetic-key';
  for (const level of ['info', 'error']) t.mock.method(console, level, () => {});
  let message = 'The "barbearia-13" instance does not exist';
  t.mock.method(global, 'fetch', async () => Response.json({ status: 404, error: 'Not Found', response: { message: [message] } }, { status: 404 }));
  await assert.rejects(api.obterEstadoConexao('barbearia-13'), { code: 'EVOLUTION_INSTANCE_NOT_FOUND', upstreamStatus: 404 });
  message = 'Cannot GET /instance/connectionState/barbearia-13';
  await assert.rejects(api.obterEstadoConexao('barbearia-13'), { code: 'EVOLUTION_ENDPOINT_NOT_FOUND', upstreamStatus: 404 });
});

test('status compartilha consultas consecutivas; cache expira e connect/logout invalidam', async t => {
  process.env.EVOLUTION_API_URL = 'https://status-cache.test';
  process.env.EVOLUTION_API_KEY = 'synthetic-key';
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  t.mock.method(console, 'info', () => {});
  const paths = [];
  t.mock.method(global, 'fetch', async url => {
    paths.push(new URL(url).pathname);
    return Response.json(url.includes('/connect/') ? { count: 0 } : { instance: { state: 'close' } });
  });
  const options = { cacheMs: 10000 };
  for (let i = 0; i < 6; i++) await api.obterEstadoConexao('one', options);
  assert.equal(paths.length, 1);
  await api.obterEstadoConexao('two', options);
  assert.equal(paths.length, 2);
  now += 10001;
  await api.obterEstadoConexao('one', options);
  assert.equal(paths.length, 3);
  assert.ok(paths.every(p => p.startsWith('/instance/connectionState/')));
  await api.conectarInstancia('one');
  await api.obterEstadoConexao('one', options);
  await api.desconectarInstancia('one');
  await api.obterEstadoConexao('one', options);
  assert.equal(paths.length, 7);
});

test('429 do webhook mantem tentativa e informa origem original no cooldown de status', async t => {
  process.env.EVOLUTION_API_URL = 'https://webhook-diagnostic.test';
  process.env.EVOLUTION_API_KEY = 'synthetic-webhook-key';
  let now = Date.now(), calls = 0;
  t.mock.method(Date, 'now', () => now);
  const logs = [];
  for (const level of ['info', 'error']) t.mock.method(console, level, (_, json) => logs.push(JSON.parse(json)));
  t.mock.method(global, 'fetch', async url => {
    calls++;
    if (url.includes('/webhook/')) return Response.json({ message: 'Webhook limited', apikey: 'synthetic-webhook-key' }, { status: 429 });
    return Response.json({ count: 0 });
  });
  await api.conectarInstancia('one');
  let diagnostic;
  await assert.rejects(api.configurarWebhookInstancia('one', 'https://app.test/api/webhook/evolution'), error => {
    diagnostic = error.diagnostic;
    return error.rateLimitSource === 'upstream' && diagnostic.endpoint === '/webhook/set/one';
  });
  assert.equal(api.tentativaConexaoAtiva('one'), true);
  await assert.rejects(api.obterEstadoConexao('one'), error => {
    assert.deepEqual(error.diagnostic, diagnostic);
    return error.rateLimitSource === 'local_cooldown' && error.upstreamStatus === undefined;
  });
  assert.equal(calls, 2);
  now += 30001;
  await api.conectarInstancia('one');
  assert.equal(calls, 2, 'webhook failure must not authorize a second connect');
  const event = logs.find(e => e.event === 'evolution_upstream_429');
  assert.equal(event.httpStatus, 429);
  assert.equal(event.endpoint, '/webhook/set/one');
  assert.equal(event.instanceName, 'one');
  assert.equal(event.attempt, 1);
  assert.ok(Number.isFinite(Date.parse(event.timestamp)));
  assert.match(event.body, /Webhook limited/);
  assert.doesNotMatch(JSON.stringify(logs), /synthetic-webhook-key/);
});

for (const fault of [503, 'timeout']) {
  test(`diagnostico preserva endpoint de status e falha ${fault}`, async t => {
    process.env.EVOLUTION_API_URL = `https://failure-${fault}.test`;
    process.env.EVOLUTION_API_KEY = 'synthetic-key';
    for (const level of ['info', 'error']) t.mock.method(console, level, () => {});
    let calls = 0;
    t.mock.method(global, 'fetch', async () => {
      calls++;
      if (fault === 'timeout') throw Object.assign(new Error('timeout'), { name: 'AbortError' });
      return Response.json({ message: 'Service unavailable' }, { status: fault });
    });
    await assert.rejects(api.obterEstadoConexao('one', { requestId: 'synthetic-request', retryAttempts: 5 }), error => {
      assert.equal(error.diagnostic.endpoint, '/instance/connectionState/one');
      assert.equal(error.diagnostic.requestId, 'synthetic-request');
      assert.equal(error.diagnostic.httpStatus, fault === 'timeout' ? null : 503);
      return error.code === (fault === 'timeout' ? 'EVOLUTION_TIMEOUT' : 'EVOLUTION_OFFLINE');
    });
    assert.equal(calls, 1);
  });
}
