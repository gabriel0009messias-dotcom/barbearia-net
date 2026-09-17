const { test } = require('node:test');
const assert = require('node:assert/strict');
const api = require('../evolutionApi');

test('diagnostico seguro da resposta upstream 429', async t => {
  const previous = { ...process.env };
  process.env.EVOLUTION_API_URL = 'https://diagnostics.test';
  process.env.EVOLUTION_API_KEY = 'fake-diagnostic-api-key';
  process.env.DATABASE_URL = 'postgresql://fake-user:fake-db-password@db.test/example';
  const logs = [];
  for (const level of ['info', 'error']) t.mock.method(console, level, (_, json) => logs.push(JSON.parse(json)));
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  });
  let calls = 0;
  let response;
  let instance = 0;
  t.mock.method(global, 'fetch', async () => { calls++; return response; });
  async function run(body, headers = {}, extra = {}) {
    response = new Response(body, { status: 429, statusText: 'Too Many Requests', headers });
    const name = `diagnostic-${++instance}`;
    await assert.rejects(api.obterEstadoConexao(name, extra), { code: 'EVOLUTION_RATE_LIMIT' });
    return { event: logs.findLast(e => e.event === 'evolution_upstream_429'), name };
  }

  await t.test('Retry-After original em segundos e data HTTP, separado do backoff', async () => {
    let result = await run('limited', { 'Retry-After': '120' });
    assert.equal(result.event.upstreamRetryAfter, '120');
    assert.equal(result.event.localBackoffSeconds, 30);
    assert.equal(result.event.effectiveRetryAfterSeconds, 120);
    const date = new Date(Date.now() + 120000).toUTCString();
    result = await run('limited', { 'Retry-After': date });
    assert.equal(result.event.upstreamRetryAfter, date);
    assert.ok(result.event.effectiveRetryAfterSeconds >= 119);
  });
  await t.test('header ausente ou invalido nao e confundido com backoff', async () => {
    for (const value of [null, 'invalid']) {
      const { event } = await run('limited', value === null ? {} : { 'Retry-After': value });
      assert.equal(event.upstreamRetryAfter, value);
      assert.equal(event.localBackoffSeconds, 30);
      assert.equal(event.effectiveRetryAfterSeconds, 30);
    }
  });
  await t.test('captura somente headers de resposta permitidos e metadados HTTP', async () => {
    const headers = { 'content-type': 'text/html', server: 'proxy', via: '1.1 gateway', 'cf-ray': 'ray-test',
      'x-ratelimit-limit': '100', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1234567890',
      'ratelimit-limit': '100', 'ratelimit-remaining': '0', 'ratelimit-reset': '60',
      'rndr-id': 'render-test', 'request-id': 'request-test', 'x-request-id': 'x-request-test' };
    const { event, name } = await run('<html>Limited</html>', { ...headers,
      'set-cookie': 'private-cookie', authorization: 'private-auth', apikey: 'private-key' },
    { headers: { authorization: 'Bearer private-request-token' } });
    assert.equal(event.endpoint, `/instance/connectionState/${name}`);
    assert.equal(event.method, 'GET');
    assert.equal(event.httpStatus, 429);
    assert.equal(event.statusText, 'Too Many Requests');
    for (const [key, value] of Object.entries(headers)) assert.equal(event[key], value);
    assert.doesNotMatch(JSON.stringify(logs), /private-cookie|private-auth|private-key|private-request-token/);
  });
  await t.test('corpo JSON e segredos aninhados', async () => {
    const { event } = await run(JSON.stringify({ message: 'Too Many Requests', nested: {
      apikey: 'hidden-key', Authorization: 'hidden-auth', token: 'hidden-token', password: 'hidden-password',
      senha: 'hidden-senha', cookie: 'hidden-cookie', pairingCode: 'hidden-pairing', code: 'hidden-code',
      DATABASE_URL: process.env.DATABASE_URL }, echo: process.env.EVOLUTION_API_KEY,
      detail: 'Cookie: hidden-message-cookie; session=hidden-session\npairing_code=hidden-message-pairing' }), { 'content-type': 'application/json' });
    assert.equal(JSON.parse(event.body).message, 'Too Many Requests');
    assert.doesNotMatch(JSON.stringify(logs), /hidden-|fake-diagnostic-api-key|fake-db-password/);
  });
  await t.test('texto e HTML sanitizados, inclusive cookies e inputs', async () => {
    const raw = '<html><h1>Too Many Requests</h1>\n' +
      'Cookie: session=cookie-secret; other=second-cookie-secret\n' +
      'Authorization: Bearer auth-secret\n' +
      'pairing_code=pair-secret password=pwd-secret api_key=api-secret token=token-secret\n' +
      '<input value="form-secret" name="password">\n' +
      `echo ${process.env.EVOLUTION_API_KEY} ${process.env.DATABASE_URL}</html>`;
    const { event } = await run(raw, { 'content-type': 'text/html' });
    assert.match(event.body, /Too Many Requests/);
    assert.doesNotMatch(JSON.stringify(logs), /cookie-secret|auth-secret|pair-secret|pwd-secret|api-secret|token-secret|form-secret|fake-diagnostic-api-key|fake-db-password/);
  });
  await t.test('trunca apos sanitizar em no maximo 1000 caracteres', async () => {
    const { event } = await run('x'.repeat(970) + ' password="' + 'boundary-secret'.repeat(50) + '" ' + 'y'.repeat(1200));
    assert.equal(event.body.length, 1000);
    assert.equal(event.bodyTruncated, true);
    assert.doesNotMatch(event.body, /boundary/);
  });
  await t.test('corpo excessivo e omitido sem expor segredo parcial', async () => {
    const { event } = await run('x'.repeat(65530) + ' password=' + 'secret'.repeat(2000));
    assert.equal(event.body, '[BODY OMITTED: size limit]');
  });
  await t.test('cooldown bloqueia chamadas e diagnostico nao aumenta retries', async () => {
    const { name } = await run('limited', { 'Retry-After': '60' }, { retryAttempts: 9 });
    const before = calls;
    const events = logs.filter(e => e.event === 'evolution_upstream_429').length;
    await assert.rejects(api.obterEstadoConexao(name), { code: 'EVOLUTION_RATE_LIMIT' });
    assert.equal(calls, before);
    assert.equal(logs.filter(e => e.event === 'evolution_upstream_429').length, events);
  });
  await t.test('falha de leitura nao substitui erro 429 nem cooldown', async () => {
    response = new Response(new ReadableStream({ start(controller) { controller.error(new Error('private-read-error')); } }), { status: 429 });
    const name = `diagnostic-${++instance}`;
    await assert.rejects(api.obterEstadoConexao(name), { code: 'EVOLUTION_RATE_LIMIT' });
    const event = logs.findLast(e => e.event === 'evolution_upstream_429');
    assert.equal(event.body, '[BODY OMITTED: read failure]');
    assert.doesNotMatch(JSON.stringify(logs), /private-read-error/);
  });
  await t.test('corpo que nao termina tem prazo limitado e preserva 429', async () => {
    response = new Response(new ReadableStream({ start() {} }), { status: 429 });
    await assert.rejects(api.obterEstadoConexao(`diagnostic-${++instance}`), { code: 'EVOLUTION_RATE_LIMIT' });
    assert.equal(logs.findLast(e => e.event === 'evolution_upstream_429').body, '[BODY OMITTED: read timeout]');
  });
  await t.test('segunda resposta 429 mostra backoff 60 sem inventar Retry-After', async sub => {
    let now = Date.now();
    sub.mock.method(Date, 'now', () => now);
    const { name } = await run('limited');
    now += 30001;
    response = new Response('limited again', { status: 429 });
    await assert.rejects(api.obterEstadoConexao(name), { code: 'EVOLUTION_RATE_LIMIT' });
    const event = logs.findLast(e => e.event === 'evolution_upstream_429');
    assert.equal(event.upstreamRetryAfter, null);
    assert.equal(event.localBackoffSeconds, 60);
    assert.equal(event.effectiveRetryAfterSeconds, 60);
  });
});
