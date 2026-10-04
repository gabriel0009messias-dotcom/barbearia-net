const { test } = require('node:test');
const assert = require('node:assert/strict');
const api = require('../evolutionApi');
const legacy = require('../src/services/evolutionApiService');

test('clientes compartilham single-flight, cache, cooldown e Retry-After', async t => {
  process.env.EVOLUTION_API_URL = 'https://centralized.test';
  process.env.EVOLUTION_API_KEY = 'synthetic-central-key';
  let now = Date.now(), calls = 0, fault = false, release;
  t.mock.method(Date, 'now', () => now);
  for (const level of ['info', 'error']) t.mock.method(console, level, () => {});
  t.mock.method(global, 'fetch', async () => {
    calls++;
    await new Promise(resolve => { release = resolve; });
    return fault ? Response.json({}, { status: 429, headers: { 'Retry-After': '120' } })
      : Response.json({ instance: { state: 'close' } });
  });
  const first = api.obterEstadoConexao('barbearia-6', { cacheMs: 10000 });
  const second = legacy.getConnectionState('barbearia-6');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1); release();
  assert.deepEqual(await first, await second);
  await legacy.getConnectionState('barbearia-6'); assert.equal(calls, 1);
  now += 10001; fault = true;
  const limited = legacy.getConnectionState('barbearia-6');
  const shared = api.obterEstadoConexao('barbearia-6', { cacheMs: 10000 });
  await new Promise(resolve => setImmediate(resolve)); release();
  for (const job of [limited, shared]) await assert.rejects(job, { rateLimitSource: 'upstream', retryAfterSeconds: 120 });
  await assert.rejects(legacy.getConnectionState('barbearia-6'), { rateLimitSource: 'local_cooldown' });
  await assert.rejects(api.enviarTextoInstancia('barbearia-6', '5511999999999', 'synthetic'), { rateLimitSource: 'local_cooldown' });
  assert.equal(calls, 2);
  now += 120001; fault = false;
  const recovered = legacy.getConnectionState('barbearia-6');
  await new Promise(resolve => setImmediate(resolve)); release();
  assert.equal((await recovered).instance.state, 'close'); assert.equal(calls, 3);
});

test('webhook invalida consulta antiga e entrega QR tardio sem novo connect', async t => {
  process.env.EVOLUTION_API_URL = 'https://late-qr.test';
  process.env.EVOLUTION_API_KEY = 'synthetic-key';
  let now = Date.now(), release, calls = 0;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(console, 'info', () => {});
  t.mock.method(global, 'fetch', async url => {
    calls++;
    if (url.includes('/connect/')) return Response.json({ count: 0 });
    await new Promise(resolve => { release = resolve; });
    return Response.json({ instance: { state: 'close' } });
  });
  await api.conectarInstancia('barbearia-6');
  const stale = api.obterEstadoConexao('barbearia-6', { cacheMs: 10000 });
  await new Promise(resolve => setImmediate(resolve));
  api.receberEventoConexao('barbearia-6', 'QRCODE_UPDATED', { qrcode: { base64: 'data:image/png;base64,c3ludGhldGlj' } });
  assert.equal(api.obterCodigoConexao('barbearia-6').base64, 'data:image/png;base64,c3ludGhldGlj');
  api.receberEventoConexao('barbearia-6', 'CONNECTION_UPDATE', { state: 'open' });
  release(); assert.equal((await stale).instance.state, 'open');
  assert.equal((await legacy.getConnectionState('barbearia-6')).instance.state, 'open');
  assert.equal(api.obterCodigoConexao('barbearia-6'), null);
  assert.equal(api.tentativaConexaoAtiva('barbearia-6'), false);
  assert.equal(calls, 2, 'evento e cache nao fazem chamadas a Evolution');
  api.receberEventoConexao('barbearia-6', 'CONNECTION_UPDATE', { state: 'close' });
  assert.equal((await legacy.getConnectionState('barbearia-6')).instance.state, 'close');
  api.receberEventoConexao('barbearia-6', 'QRCODE_UPDATED', { base64: 'synthetic' });
  now += 60001; assert.equal(api.obterCodigoConexao('barbearia-6'), null);
});

test('open recebido durante connect preserva confirmacao e encerra reserva ao concluir', async t => {
  process.env.EVOLUTION_API_URL = 'https://open-during-connect.test';
  process.env.EVOLUTION_API_KEY = 'synthetic-key';
  t.mock.method(console, 'info', () => {});
  let release;
  t.mock.method(global, 'fetch', async () => {
    await new Promise(resolve => { release = resolve; });
    return Response.json({ count: 0 });
  });
  const job = api.conectarInstancia('barbearia-6');
  await new Promise(resolve => setImmediate(resolve));
  api.receberEventoConexao('barbearia-6', 'CONNECTION_UPDATE', { state: 'open' });
  release();
  assert.equal((await job).instance.state, 'open');
  assert.equal(api.tentativaConexaoAtiva('barbearia-6'), false);
  assert.equal((await legacy.getConnectionState('barbearia-6')).instance.state, 'open');
});
