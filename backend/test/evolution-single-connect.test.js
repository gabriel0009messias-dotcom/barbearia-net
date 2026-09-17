const { test } = require('node:test');
const assert = require('node:assert/strict');
const api = require('../evolutionApi');

for (const [mode, number] of [['pairing', '5511999999999'], ['qr', '']]) {
  for (const code of [false, true]) {
    test(`${mode}: concorrencia, codigo=${code}, tempo e polling nunca repetem connect`, async t => {
      process.env.EVOLUTION_API_URL = `https://${mode}-${code}.test`;
      process.env.EVOLUTION_API_KEY = 'fake-single-connect-key';
      t.mock.method(console, 'info', () => {});
      let now = Date.now();
      t.mock.method(Date, 'now', () => now);
      const calls = [];
      t.mock.method(global, 'fetch', async url => {
        const path = new URL(url).pathname;
        calls.push(path);
        await new Promise(resolve => setTimeout(resolve, 5));
        if (path.includes('/connect/')) return Response.json(code
          ? (number ? { pairingCode: 'TEST1234' } : { base64: 'data:image/png;base64,test' }) : { count: 0 });
        return Response.json({ instance: { state: 'close' } });
      });
      const responses = await Promise.all([
        api.conectarInstancia('same', number), api.conectarInstancia('same', number),
      ]);
      assert.deepEqual(responses[0], responses[1]);
      now += 240000; // Longer than both the old cache and the UI polling window.
      for (let i = 0; i < 3; i++) await api.obterEstadoConexao('same');
      assert.equal(api.tentativaConexaoAtiva('same'), true);
      await api.conectarInstancia('same', number);
      await assert.rejects(api.conectarInstancia('same', number ? '' : '5511999999999'), { code: 'WHATSAPP_BUSY' });
      assert.equal(calls.filter(path => path.includes('/connect/')).length, 1);
      assert.equal(calls.filter(path => path.includes('/connectionState/')).length, 3);
      await api.desconectarInstancia('same');
      assert.equal(api.tentativaConexaoAtiva('same'), false);
      await api.conectarInstancia('same', number);
      assert.equal(calls.filter(path => path.includes('/connect/')).length, 2, 'only explicit logout enables another attempt');
    });
  }

  test(`${mode}: 429 externo encerra tentativa; cooldown local nao finge resposta upstream`, async t => {
    process.env.EVOLUTION_API_URL = `https://${mode}-429.test`;
    process.env.EVOLUTION_API_KEY = 'fake-single-connect-key';
    const logs = [];
    for (const level of ['info', 'error']) t.mock.method(console, level, (_, json) => logs.push(JSON.parse(json)));
    let now = Date.now();
    t.mock.method(Date, 'now', () => now);
    let calls = 0;
    t.mock.method(global, 'fetch', async () => {
      calls++;
      return new Response('{"message":"limited","apikey":"fake-single-connect-key"}', { status: 429, headers: { 'Retry-After': '120' } });
    });
    await assert.rejects(api.conectarInstancia('same', number, { retryAttempts: 9 }), {
      code: 'EVOLUTION_RATE_LIMIT', rateLimitSource: 'upstream', upstreamStatus: 429,
    });
    assert.equal(api.tentativaConexaoAtiva('same'), false);
    for (const operation of [() => api.conectarInstancia('same', number), () => api.obterEstadoConexao('same')]) {
      await assert.rejects(operation(), error => error.rateLimitSource === 'local_cooldown' && error.upstreamStatus === undefined);
    }
    now += 120001;
    await Promise.resolve();
    assert.equal(calls, 1, 'cooldown expiry never schedules connect');
    assert.equal(logs.filter(event => event.event === 'evolution_upstream_429').length, 1);
    assert.doesNotMatch(JSON.stringify(logs), /fake-single-connect-key/);
  });
}

test('timeout de connect preserva tentativa incerta ate encerramento explicito', async t => {
  process.env.EVOLUTION_API_URL = 'https://uncertain-connect.test';
  process.env.EVOLUTION_API_KEY = 'fake-single-connect-key';
  for (const level of ['info', 'error']) t.mock.method(console, level, () => {});
  let calls = 0;
  t.mock.method(global, 'fetch', async () => { calls++; throw Object.assign(new Error('timeout'), { name: 'AbortError' }); });
  await assert.rejects(api.conectarInstancia('same'), { code: 'EVOLUTION_TIMEOUT' });
  await assert.rejects(api.conectarInstancia('same'), { code: 'EVOLUTION_TIMEOUT' });
  assert.equal(api.tentativaConexaoAtiva('same'), true);
  assert.equal(calls, 1);
});

test('429 no polling encerra tentativa que ja tinha codigo e impede novo connect', async t => {
  process.env.EVOLUTION_API_URL = 'https://polling-429.test';
  process.env.EVOLUTION_API_KEY = 'fake-single-connect-key';
  for (const level of ['info', 'error']) t.mock.method(console, level, () => {});
  let connects = 0;
  t.mock.method(global, 'fetch', async url => {
    if (url.includes('/connect/')) { connects++; return Response.json({ pairingCode: 'TEST1234' }); }
    return new Response('limited', { status: 429, headers: { 'Retry-After': '120' } });
  });
  await api.conectarInstancia('same', '5511999999999');
  assert.equal(api.tentativaConexaoAtiva('same'), true);
  await assert.rejects(api.obterEstadoConexao('same'), { rateLimitSource: 'upstream' });
  assert.equal(api.tentativaConexaoAtiva('same'), false);
  await assert.rejects(api.conectarInstancia('same', '5511999999999'), { rateLimitSource: 'local_cooldown' });
  assert.equal(connects, 1);
});

test('estado open de consulta anterior nao remove reserva de connect ainda pendente', async t => {
  process.env.EVOLUTION_API_URL = 'https://state-connect-race.test';
  process.env.EVOLUTION_API_KEY = 'fake-single-connect-key';
  t.mock.method(console, 'info', () => {});
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let connects = 0;
  t.mock.method(global, 'fetch', async url => {
    if (url.includes('/connectionState/')) return Response.json({ instance: { state: 'open' } });
    connects++;
    await gate;
    return Response.json({ pairingCode: 'TEST1234' });
  });
  const state = api.obterEstadoConexao('same');
  const first = api.conectarInstancia('same', '5511999999999');
  await state;
  const second = api.conectarInstancia('same', '5511999999999');
  release();
  await Promise.all([first, second]);
  assert.equal(connects, 1);
  assert.equal(api.tentativaConexaoAtiva('same'), true);
  await api.obterEstadoConexao('same');
  assert.equal(api.tentativaConexaoAtiva('same'), false, 'confirmed open after completion releases attempt');
});
