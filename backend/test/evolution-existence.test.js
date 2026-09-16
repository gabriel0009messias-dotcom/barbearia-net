const { test } = require('node:test');
const assert = require('node:assert/strict');
const api = require('../evolutionApi');

test('existencia: TTL 60s, concorrencia, isolamento por URL e invalidacao', async t => {
  let now = 1000000;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(console, 'info', () => {});
  t.mock.method(console, 'error', () => {});
  process.env.EVOLUTION_API_URL = 'https://existence.test';
  process.env.EVOLUTION_API_KEY = 'test-only-secret';
  const calls = [];
  let absent = false;
  t.mock.method(global, 'fetch', async url => {
    calls.push(String(url));
    if (String(url).includes('/connectionState/')) {
      return absent ? Response.json({ message: 'Instance not found' }, { status: 404 }) : Response.json({ instance: { state: 'open' }, token: 'never-cache-this' });
    }
    return Response.json([{ name: 'salon', token: 'never-cache-this', pairingCode: 'never-cache-code' }]);
  });
  assert.deepEqual(await Promise.all([api.confirmarExistenciaInstancia('salon'), api.confirmarExistenciaInstancia('salon')]), [true, true]);
  assert.equal(calls.length, 1);
  now += 59999;
  assert.equal(await api.confirmarExistenciaInstancia('salon'), true);
  assert.equal(calls.length, 1);
  now++;
  await api.confirmarExistenciaInstancia('salon');
  assert.equal(calls.length, 2);
  api.invalidarExistenciaInstancia('salon');
  await api.confirmarExistenciaInstancia('salon');
  assert.equal(calls.length, 3);
  process.env.EVOLUTION_API_URL = 'https://other-existence.test';
  await api.confirmarExistenciaInstancia('salon');
  assert.equal(calls.length, 4);
  absent = true;
  await assert.rejects(api.obterEstadoConexao('salon'), { code: 'EVOLUTION_INSTANCE_NOT_FOUND' });
  await api.confirmarExistenciaInstancia('salon');
  assert.equal(calls.length, 6, '404 invalidou a existencia anterior');
  await api.evolutionRequest('/instance/delete/salon', { method: 'DELETE' });
  await api.confirmarExistenciaInstancia('salon');
  assert.equal(calls.length, 8, 'exclusao invalidou o cache');
});

test('estado valido e criacao alimentam somente existencia; recriacao invalida consulta antiga', async t => {
  process.env.EVOLUTION_API_URL = 'https://state-cache.test';
  process.env.EVOLUTION_API_KEY = 'test-only-secret';
  t.mock.method(console, 'info', () => {});
  let calls = 0;
  t.mock.method(global, 'fetch', async () => { calls++; return Response.json({ instance: { state: 'close' }, token: 'secret', pairingCode: 'secret-code' }); });
  await api.obterEstadoConexao('salon');
  assert.equal(await api.confirmarExistenciaInstancia('salon'), true);
  assert.equal(calls, 1);
  await api.criarInstancia('salon');
  assert.equal(await api.confirmarExistenciaInstancia('salon'), true);
  assert.equal(calls, 2);
  const cache = require('../evolutionExistenceCache');
  let release;
  const pending = cache.confirm('race', () => new Promise(resolve => { release = resolve; }));
  await Promise.resolve();
  cache.invalidate('race');
  release(true);
  await pending;
  let lookups = 0;
  await cache.confirm('race', async () => { lookups++; return true; });
  assert.equal(lookups, 1, 'resposta antiga nao repopula cache invalidado');
});

test('erros e ausencia nao viram existencia em cache; cache positivo respeita cooldown', async t => {
  process.env.EVOLUTION_API_URL = 'https://cache-errors.test';
  process.env.EVOLUTION_API_KEY = 'test-only-secret';
  t.mock.method(console, 'info', () => {});
  t.mock.method(console, 'error', () => {});
  let calls = 0;
  let status = 500;
  t.mock.method(global, 'fetch', async () => {
    calls++;
    return Response.json(status === 200 ? [{ name: 'salon' }] : { message: 'Instance not found' }, { status, headers: { 'Retry-After': '60' } });
  });
  for (status of [401, 403, 500, 502, 503]) await assert.rejects(api.confirmarExistenciaInstancia('salon'));
  assert.equal(calls, 5);
  status = 404;
  assert.equal(await api.confirmarExistenciaInstancia('salon'), false);
  assert.equal(await api.confirmarExistenciaInstancia('salon'), false);
  assert.equal(calls, 7);
  status = 200;
  assert.equal(await api.confirmarExistenciaInstancia('salon'), true);
  status = 429;
  await assert.rejects(api.obterEstadoConexao('salon'), { code: 'EVOLUTION_RATE_LIMIT' });
  const before = calls;
  await assert.rejects(api.confirmarExistenciaInstancia('salon'), { code: 'EVOLUTION_RATE_LIMIT' });
  assert.equal(calls, before);
});


test('lista invalida nao e prova de ausencia', async t => {
  process.env.EVOLUTION_API_URL = 'https://invalid-list.test';
  process.env.EVOLUTION_API_KEY = 'test-only-secret';
  t.mock.method(console, 'info', () => {});
  t.mock.method(console, 'error', () => {});
  t.mock.method(global, 'fetch', async () => Response.json([{}]));
  await assert.rejects(api.confirmarExistenciaInstancia('salon'), { code: 'EVOLUTION_INVALID_RESPONSE' });
});
