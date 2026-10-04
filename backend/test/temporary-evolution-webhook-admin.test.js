const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

test('temporary webhook admin: real admin auth, fixed scope and secret-safe verification', { timeout: 60000 }, async t => {
  const previous = { ...process.env };
  const realNow = Date.now;
  let clockOffset = 0;
  t.mock.method(Date, 'now', () => realNow() + clockOffset);
  const environment = require('./helpers/postgres').testEnvironment();
  process.env.LEGACY_ADMIN_EMAIL = 'temporary-admin@example.test';
  process.env.LEGACY_ADMIN_PASSWORD = 'synthetic-admin-password';
  process.env.EVOLUTION_API_KEY = 'synthetic-evolution-key';
  process.env.EVOLUTION_WEBHOOK_SECRET = 'synthetic-maintenance-secret';
  process.env.AUTHENTICATION_API_KEY = 'synthetic-authentication-marker';
  process.env.DATABASE_CONNECTION_URI = 'postgresql://fixture:synthetic-database-marker@db.test/db';
  const secret = process.env.EVOLUTION_WEBHOOK_SECRET;
  const logs = [];
  for (const method of ['info', 'error', 'warn', 'log']) {
    t.mock.method(console, method, (...args) => logs.push(args.join(' ')));
  }
  const calls = [];
  let saved;
  let mode = 'ok';
  let release;
  const upstream = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', async () => {
      calls.push({ method: req.method, path: req.url, body: raw ? JSON.parse(raw) : null });
      assert.equal(req.headers.apikey, 'synthetic-evolution-key');
      const write = req.method === 'POST' && req.url === '/webhook/set/barbearia-6';
      assert.ok(write || (req.method === 'GET' && req.url === '/webhook/find/barbearia-6'));
      if (mode === 'rate-limit') {
        res.writeHead(429, { 'Retry-After': '30', 'Content-Type': 'text/plain',
          Server: `edge-test ${process.env.AUTHENTICATION_API_KEY} ${secret}`,
          Via: `1.1 proxy-test ${process.env.DATABASE_CONNECTION_URI}`, 'CF-Ray': 'test-ray',
          'CF-Cache-Status': 'DYNAMIC', 'X-Request-ID': 'upstream-test',
          'X-Render-Origin-Server': 'render-test', 'X-Render-Secret': secret,
          Authorization: 'Bearer private-auth', Cookie: 'private-cookie',
          'Set-Cookie': 'private-set-cookie', apikey: process.env.EVOLUTION_API_KEY });
        return res.end('Too Many Requests\n');
      }
      if (mode === 'hold' && write) await new Promise(resolve => { release = resolve; });
      if ((mode === 'set-error' && write) || (mode === 'read-error' && !write)) {
        res.writeHead(500);
        return res.end(JSON.stringify({ error: true, secret, headers: { 'x-webhook-secret': secret } }));
      }
      if (write) {
        const data = JSON.parse(raw).webhook;
        assert.deepEqual(data, { enabled: true,
          url: 'https://barbearia-net.onrender.com/api/webhook/evolution',
          byEvents: false, base64: false,
          events: ['CONNECTION_UPDATE', 'QRCODE_UPDATED', 'MESSAGES_UPSERT'],
          headers: { 'x-webhook-secret': secret } });
        saved = { ...data, webhookByEvents: data.byEvents, webhookBase64: data.base64 };
      }
      let response = structuredClone(saved);
      if (!write) {
        if (mode === 'missing-header') delete response.headers;
        if (mode === 'wrong-header') response.headers['x-webhook-secret'] = 'wrong';
        if (mode === 'wrong-url') response.url = 'https://other.test';
        if (mode === 'extra-event') response.events.push('MESSAGES_UPDATE');
        if (mode === 'wrong-flags') response.webhookByEvents = response.webhookBase64 = true;
        if (mode === 'disabled') response.enabled = false;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response));
    });
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  process.env.EVOLUTION_API_URL = `http://127.0.0.1:${upstream.address().port}`;
  const db = require('../database');
  await db.ready;
  const app = express();
  app.use(express.json());
  app.use('/api', require('../routes'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    for (const current of [server, upstream]) {
      current.closeAllConnections();
      await new Promise(resolve => current.close(resolve));
    }
    await db.close(); await environment.cleanup();
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const route = '/admin/whatsapp/barbearia-6/webhook-temporario';
  async function request(endpoint, token, body = {}, method = 'POST') {
    const response = await fetch(base + endpoint, { method,
      headers: { 'Content-Type': 'application/json', ...(token ? { 'x-admin-token': token } : {}) },
      ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) });
    const data = await response.json();
    assert.ok(Object.entries(data).every(([key, value]) => key === 'diagnostic' || typeof value === 'boolean'));
    assert.ok(!JSON.stringify(data).includes(secret));
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return { status: response.status, data };
  }
  const login = await fetch(base + '/admin/login', { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: process.env.LEGACY_ADMIN_EMAIL, senha: process.env.LEGACY_ADMIN_PASSWORD }) });
  assert.equal(login.status, 200);
  const token = (await login.json()).token;

  await t.test('missing/forged admin tokens and barber credentials cannot call Evolution', async () => {
    for (const candidate of [undefined, 'forged', 'synthetic-barber-token']) {
      assert.equal((await request(route, candidate)).status, 401);
    }
    assert.equal(calls.length, 0);
  });
  await t.test('client cannot override instance, URL, events or header', async () => {
    for (const body of [{ instance: 'barbearia-7' }, { url: 'https://other.test' },
      { events: [] }, { headers: { 'x-webhook-secret': 'other' } }, []]) {
      assert.equal((await request(route, token, body)).status, 400);
    }
    assert.equal((await request(route + '?instance=barbearia-7', token)).status, 400);
    assert.equal(calls.length, 0);
  });
  await t.test('missing environment secret fails before any upstream call', async () => {
    delete process.env.EVOLUTION_WEBHOOK_SECRET;
    assert.deepEqual(await request(route, token), { status: 503, data: { segredoConfigurado: false } });
    process.env.EVOLUTION_WEBHOOK_SECRET = secret;
    assert.equal(calls.length, 0);
  });
  await t.test('upstream failures never disclose secret or report successful verification', async () => {
    for (mode of ['set-error', 'read-error']) {
      const result = await request(route, token);
      assert.equal(result.status, 502);
      assert.equal(result.data.verificacaoConcluida, false);
      assert.equal(result.data.configuracaoAplicada, mode === 'read-error');
    }
  });
  await t.test('429 returns safe upstream evidence, one POST, no read/retry; cooldown sends nothing', async sub => {
    sub.after(() => { clockOffset += 31000; });
    mode = 'rate-limit';
    process.env.EVOLUTION_API_RETRY_ATTEMPTS = '9';
    const before = calls.length;
    const result = await request(route, token);
    assert.equal(result.status, 502);
    assert.equal(calls.length, before + 1);
    assert.equal(calls.at(-1).path, '/webhook/set/barbearia-6');
    const diagnostic = result.data.diagnostic;
    assert.equal(diagnostic.httpStatus, 429);
    assert.equal(diagnostic.statusText, 'Too Many Requests');
    assert.equal(diagnostic.method, 'POST');
    assert.equal(diagnostic.endpoint, '/webhook/set/barbearia-6');
    assert.equal(diagnostic.origin, process.env.EVOLUTION_API_URL);
    assert.ok(diagnostic.durationMs >= 0);
    assert.equal(diagnostic.upstreamRetryAfter, '30');
    assert.equal(diagnostic.headers['retry-after'], '30');
    assert.equal(diagnostic.headers['x-render-origin-server'], 'render-test');
    assert.equal(diagnostic.headers['cf-cache-status'], 'DYNAMIC');
    assert.equal(diagnostic.body, 'Too Many Requests');
    assert.equal(diagnostic.classification.producerConfirmed, false);
    assert.equal(diagnostic.classification.confidence, 'low');
    for (const name of ['authorization', 'cookie', 'set-cookie', 'apikey', 'x-render-secret']) assert.equal(diagnostic.headers[name], undefined);
    assert.doesNotMatch(JSON.stringify(result.data), /synthetic-evolution-key|synthetic-maintenance-secret|synthetic-authentication-marker|synthetic-database-marker|private-auth|private-cookie|private-set-cookie|stack/);
    const blocked = await request(route, token);
    assert.equal(calls.length, before + 1);
    assert.equal(blocked.data.diagnostic.httpStatus, null);
    assert.equal(blocked.data.diagnostic.classification.probableOrigin, 'studiofy_local_cooldown');
    assert.doesNotMatch(logs.join('\n'), /synthetic-maintenance-secret|synthetic-evolution-key|synthetic-authentication-marker|synthetic-database-marker|private-auth|private-cookie|private-set-cookie/);
  });
  await t.test('saved header, URL, events, flags and enabled state are verified', async () => {
    for (mode of ['missing-header', 'wrong-header', 'wrong-url', 'extra-event', 'wrong-flags', 'disabled']) {
      const result = await request(route, token);
      assert.equal(result.status, 502);
      assert.equal(result.data.verificacaoConcluida, false);
    }
  });
  await t.test('concurrency is blocked; successful request sets and reads only barbearia-6', async () => {
    mode = 'hold';
    const first = request(route, token);
    const deadline = realNow() + 5000;
    while (!release && realNow() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(typeof release, 'function', 'The held upstream request must be reached');
    const count = calls.length;
    assert.deepEqual(await request(route, token), { status: 409, data: { operacaoEmAndamento: true } });
    assert.equal(calls.length, count);
    release();
    const result = await first;
    assert.equal(result.status, 200);
    assert.equal(result.data.configuracaoAplicada, true);
    assert.equal(result.data.somenteVerificacao, false);
    assert.equal(result.data.verificacaoConcluida, true);
  });
  await t.test('subsequent requests only read, including when stored config later differs', async () => {
    const writes = calls.filter(call => call.method === 'POST').length;
    mode = 'ok';
    const result = await request(route, token);
    assert.equal(result.status, 200);
    assert.equal(result.data.somenteVerificacao, true);
    assert.equal(result.data.configuracaoAplicada, false);
    mode = 'wrong-header';
    assert.equal((await request(route, token)).status, 502);
    assert.equal(calls.filter(call => call.method === 'POST').length, writes);
    assert.ok(!logs.join('\n').includes(secret));
    assert.ok(!logs.join('\n').includes('synthetic-evolution-key'));
  });
  await t.test('expired real admin session is rejected', async () => {
    const later = Date.now() + 13 * 60 * 60 * 1000;
    const clock = t.mock.method(Date, 'now', () => later);
    const count = calls.length;
    assert.equal((await request(route, token)).status, 401);
    assert.equal(calls.length, count);
    clock.mock.restore();
  });
});
