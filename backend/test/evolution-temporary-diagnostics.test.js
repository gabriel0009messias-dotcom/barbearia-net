const { test } = require('node:test');
const assert = require('node:assert/strict');
const { safeBody, safeHeaders, SAFE_HEADERS, BODY_LIMIT, responseDiagnostic, classifyOrigin, routeDiagnostic } = require('../evolutionDiagnostics');
const api = require('../evolutionApi');

test('temporary body policy omits arbitrary data, HTML and partial credentials', () => {
  for (const raw of ['arbitrary private customer data', '<html>Too Many Requests<input value="private"></html>',
    'Too Many Requests\nunknownField=private', JSON.stringify({ message: 'private', other: 'private' }),
    'x'.repeat(250) + 'partial-private-secret'.repeat(100)]) {
    const result = safeBody(raw);
    assert.ok(result.body.length <= BODY_LIMIT);
    assert.equal(result.bodyOmitted, true);
    assert.doesNotMatch(result.body, /private/);
  }
  assert.equal(safeBody('x'.repeat(1000)).bodyTruncated, true);
  assert.equal(safeBody('Too Many Requests\n').body, 'Too Many Requests');
  assert.equal(safeBody(JSON.stringify({ message: 'Too Many Requests', arbitrary: 'private' })).body, 'Too Many Requests');
});

test('temporary errors: allowlist, environment secret redaction, no retries and bounded reads', async t => {
  const previous = { ...process.env };
  process.env.EVOLUTION_API_URL = 'https://temporary-diagnostics.test';
  process.env.EVOLUTION_API_KEY = 'synthetic-api-private';
  process.env.AUTHENTICATION_API_KEY = 'synthetic-auth-private';
  process.env.EVOLUTION_WEBHOOK_SECRET = 'synthetic-webhook-private';
  process.env.DATABASE_CONNECTION_URI = 'postgresql://user:synthetic-db-private@db.test/db';
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  });
  const logs = [];
  for (const level of ['info', 'error']) t.mock.method(console, level, (...args) => logs.push(args.join(' ')));
  let response, calls = 0;
  t.mock.method(global, 'fetch', async () => { calls++; return response; });
  for (const status of [429, 400, 401, 403, 404, 500, 502, 503, 504]) {
    response = new Response(JSON.stringify({ message: 'Too Many Requests', arbitrary: 'unknown-private',
      Authorization: 'private-auth', secret: process.env.EVOLUTION_WEBHOOK_SECRET }), {
      status, headers: { 'retry-after': '30', server: `edge ${process.env.AUTHENTICATION_API_KEY} ${process.env.EVOLUTION_WEBHOOK_SECRET}`,
        via: `1.1 ${process.env.DATABASE_CONNECTION_URI}`, 'x-request-id': process.env.EVOLUTION_API_KEY,
        'set-cookie': 'private-cookie', authorization: 'private-auth', 'x-render-token': 'private-token' } });
    const before = calls;
    await assert.rejects(api.evolutionRequest(`/webhook/set/test-${status}`, {
      method: 'POST', retryAttempts: 9, temporaryDiagnostics: true,
      headers: { Authorization: 'Bearer private-request' }, body: JSON.stringify({ secret: process.env.EVOLUTION_WEBHOOK_SECRET }),
    }), error => {
      assert.equal(error.upstreamStatus, status);
      const diagnostic = error.upstreamDiagnostic;
      assert.equal(diagnostic.httpStatus, status);
      assert.equal(diagnostic.headers['retry-after'], '30');
      assert.equal(diagnostic.body, 'Too Many Requests');
      assert.ok(Object.keys(diagnostic.headers).every(name => SAFE_HEADERS.includes(name)));
      assert.doesNotMatch(JSON.stringify(diagnostic), /synthetic-.*private|private-auth|private-cookie|private-token|unknown-private|private-request/);
      return true;
    });
    assert.equal(calls, before + 1);
  }
  assert.doesNotMatch(logs.join('\n'), /synthetic-.*private|private-auth|private-cookie|private-token|unknown-private|private-request/);
  const context = { endpoint: '/webhook/set/test', method: 'POST', origin: 'https://temporary-diagnostics.test' };
  for (const [body, expected] of [
    ['x'.repeat(9000), 'size limit'],
    [new ReadableStream({ start(controller) { controller.error(Error('private')); } }), 'read failure'],
    [new ReadableStream({ start() {} }), 'read timeout'],
  ]) {
    const diagnostic = await responseDiagnostic(new Response(body, { status: 429 }), context, Date.now());
    assert.equal(diagnostic.body, `[BODY OMITTED: ${expected}]`);
    assert.equal(diagnostic.bodyTruncated, true);
  }
});

test('edge headers indicate transit without asserting who generated 429', () => {
  const result = classifyOrigin({ server: 'cloudflare', 'rndr-id': 'render-id', via: 'proxy' }, 429);
  assert.deepEqual(result.evidence, ['cloudflare_in_path', 'render_in_path', 'proxy_in_path']);
  assert.equal(result.producerConfirmed, false);
  const headers = safeHeaders(new Headers({ server: 'x'.repeat(4000), 'x-render-secret': 'private', authorization: 'private' }));
  assert.ok(headers.server.length <= 256);
  assert.equal(headers['x-render-secret'], undefined);
  assert.equal(headers.authorization, undefined);
  const fallback = routeDiagnostic({ diagnostic: { httpStatus: 200, body: 'private' }, stack: 'private' });
  assert.equal(fallback.httpStatus, 200);
  assert.equal(fallback.classification.probableOrigin, 'upstream_response_without_safe_details');
  assert.doesNotMatch(JSON.stringify(fallback), /private|stack/);
});
