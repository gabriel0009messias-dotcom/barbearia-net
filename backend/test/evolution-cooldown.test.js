const { test } = require('node:test');
const assert = require('node:assert/strict');
const guard = require('../evolutionConnectionGuard');
const api = require('../evolutionApi');

test('Retry-After aceita segundos, data, ausente e invalido', () => {
  assert.equal(guard.retryAfterMs('120', 0), 120000);
  assert.equal(guard.retryAfterMs('Thu, 01 Jan 1970 00:02:00 GMT', 0), 120000);
  for (const value of [null, '', 'invalid', '-1', '1.5', '999999999999999999999999999']) assert.equal(guard.retryAfterMs(value), 0);
  assert.equal(guard.retryAfterMs('Thu, 01 Jan 1970 00:00:00 GMT'), 0);
});

test('429 com data HTTP protege fila e logs sem registrar corpo ou credenciais', async t => {
  const now = Date.parse('2026-09-16T12:00:00Z');
  t.mock.method(Date, 'now', () => now);
  process.env.EVOLUTION_API_URL = 'https://date.test';
  process.env.EVOLUTION_API_KEY = 'date-secret-key';
  const logs = [];
  t.mock.method(console, 'info', (...args) => logs.push(args.join(' ')));
  t.mock.method(console, 'error', (...args) => logs.push(args.join(' ')));
  let calls = 0;
  t.mock.method(global, 'fetch', async () => {
    calls++;
    return new Response('{"apikey":"date-secret-key","pairingCode":"PRIVATE-CODE"}', {
      status: 429, headers: { 'Retry-After': 'Wed, 16 Sep 2026 12:05:00 GMT' },
    });
  });
  const results = await Promise.allSettled([api.buscarInstancia('queued'), api.obterEstadoConexao('queued')]);
  for (const result of results) {
    assert.equal(result.status, 'rejected');
    assert.equal(result.reason.retryAfterSeconds, 300);
  }
  assert.equal(calls, 1, 'a chamada ja enfileirada tambem respeita o cooldown');
  const output = logs.join('\n');
  assert.match(output, /rate_limit/);
  assert.match(output, /retryAfterSeconds/);
  assert.doesNotMatch(output, /date-secret-key|PRIVATE-CODE/);
});

test('cooldown por instancia respeita Retry-After e cresce sem repetir chamadas', async t => {
  let now = 1000000;
  t.mock.method(Date, 'now', () => now);
  process.env.EVOLUTION_API_URL = 'https://evolution.test';
  process.env.EVOLUTION_API_KEY = 'test-secret';
  let calls = 0;
  t.mock.method(global, 'fetch', async () => {
    calls++;
    return new Response('{}', { status: 429, headers: { 'Retry-After': calls === 1 ? '120' : 'invalid' } });
  });
  t.mock.method(console, 'info', () => {});
  t.mock.method(console, 'error', () => {});
  await assert.rejects(api.conectarInstancia('limited', '', { retryAttempts: 9 }), e => e.statusCode === 429 && e.retryAfterSeconds === 120);
  await assert.rejects(api.buscarInstancia('limited'), e => e.retryAfterSeconds === 120);
  await assert.rejects(api.obterEstadoConexao('limited'), { code: 'EVOLUTION_RATE_LIMIT' });
  assert.equal(calls, 1);
  now += 120000;
  await assert.rejects(api.conectarInstancia('limited'), e => e.retryAfterSeconds === 60);
  assert.equal(calls, 2);
  now += 60000;
  await assert.rejects(api.conectarInstancia('limited'), e => e.retryAfterSeconds === 120);
  assert.equal(calls, 3);
  await assert.rejects(api.obterEstadoConexao('another'), { code: 'EVOLUTION_RATE_LIMIT' });
  assert.equal(calls, 4, 'outra instancia possui cooldown independente');
});

test('connect simultaneo compartilha codigo; status compartilha chamada; endpoints sao serializados', async t => {
  process.env.EVOLUTION_API_URL = 'https://concurrency.test';
  process.env.EVOLUTION_API_KEY = 'test-secret';
  let active = 0, maximum = 0, calls = 0;
  t.mock.method(console, 'info', () => {});
  t.mock.method(global, 'fetch', async url => {
    calls++; active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 20));
    active--;
    return new Response(JSON.stringify(url.includes('/connect/') ? { pairingCode: 'TEST1234' } : { instance: { state: 'connecting' } }));
  });
  const results = await Promise.all([
    api.conectarInstancia('same', '5511999999999'), api.conectarInstancia('same', '5511999999999'),
    api.obterEstadoConexao('same'), api.obterEstadoConexao('same'),
  ]);
  assert.equal(results[0].pairingCode, results[1].pairingCode);
  assert.equal(calls, 2);
  assert.equal(maximum, 1);
  await api.conectarInstancia('same', '5511999999999');
  assert.equal(calls, 2, 'codigo recente e reutilizado sem chamar Evolution');
  await assert.rejects(api.conectarInstancia('same', '5511888888888'), { code: 'WHATSAPP_BUSY' });
});
