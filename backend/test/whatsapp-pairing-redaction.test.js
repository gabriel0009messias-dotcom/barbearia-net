const { test } = require('node:test');
const assert = require('node:assert/strict');
const api = require('../evolutionApi');
const { sanitize, logEvolution } = require('../evolutionLog');
const { safeHeaders, routeDiagnostic } = require('../evolutionDiagnostics');
const raw = 'AUDIT_SYNTHETIC_QR_806,EPHEMERAL_MATERIAL';
const pairing = 'AUDI9876';

test('pairing content is omitted regardless of field, header or exception position', async t => {
  process.env.EVOLUTION_API_URL = 'https://security-final.invalid';
  process.env.EVOLUTION_API_KEY = 'synthetic-final-api-secret';
  process.env.EVOLUTION_WEBHOOK_SECRET = 'synthetic-final-webhook-secret';
  const forbidden = [raw, pairing, process.env.EVOLUTION_API_KEY, process.env.EVOLUTION_WEBHOOK_SECRET];
  function noSecrets(value) { const json = JSON.stringify(value); for (const secret of forbidden) assert.ok(!json.includes(secret), 'Sensitive content must never survive projection'); }
  const logs = [];
  for (const level of ['info', 'error']) t.mock.method(console, level, (...args) => logs.push(args.join(' ')));
  await t.test('arbitrary object fields, scalar text and serialized exceptions are conservative', () => {
    for (const secret of forbidden) {
      noSecrets(sanitize(secret));
      noSecrets(sanitize({ message: secret, server: secret, unexpected: secret, [secret]: secret }));
      noSecrets(sanitize(Object.assign(new Error(secret), { cause: new Error(secret), details: { unknown: secret } })));
      logEvolution('failure', { message: secret, error: new Error(secret) }, 'error');
    }
    noSecrets(logs);
  });
  await t.test('operational HTTP code, local UUID, duration and retry timing remain useful', () => {
    const value = sanitize({ httpStatus: 429, durationMs: 31, requestId: '6e7b5189-2da9-411a-812f-2017b3a08d19', method: 'GET', retryAfterSeconds: 30 });
    assert.equal(value.httpStatus, 429); assert.equal(value.durationMs, 31); assert.equal(value.method, 'GET');
    assert.equal(value.requestId, '6e7b5189-2da9-411a-812f-2017b3a08d19'); assert.equal(value.retryAfterSeconds, 30);
  });
  let count = 0;
  for (const temporaryDiagnostics of [false, true]) for (const location of ['x-request-id', 'server', 'statusText', 'message', 'unexpected-header']) {
    await t.test(`${temporaryDiagnostics ? 'temporary' : 'normal'} provider error sanitizes ${location}`, async child => {
      const body = { message: location === 'message' ? raw : 'Too Many Requests', pairingCode: pairing, secret: process.env.EVOLUTION_WEBHOOK_SECRET };
      const headers = { 'retry-after': '30' };
      if (location !== 'statusText' && location !== 'message') headers[location === 'unexpected-header' ? 'x-unexpected-pairing' : location] = raw + pairing;
      child.mock.method(global, 'fetch', async () => Response.json(body, { status: 429, statusText: location === 'statusText' ? raw + pairing : 'Too Many Requests', headers }));
      await assert.rejects(api.obterEstadoConexao(`final-${++count}`, { temporaryDiagnostics }), error => {
        assert.equal(error.upstreamStatus, 429);
        const projected = routeDiagnostic(error); noSecrets(projected); noSecrets(sanitize(error));
        if (temporaryDiagnostics) { assert.equal(projected.statusText, 'Too Many Requests'); assert.equal(projected.headers['retry-after'], '30'); }
        return true;
      });
      noSecrets(logs);
    });
  }
  await t.test('numeric eight-character pairing cannot become a Retry-After or cooldown', async child => {
    child.mock.method(global, 'fetch', async () => Response.json({}, { status: 429, headers: { 'retry-after': '12345678' } }));
    await assert.rejects(api.obterEstadoConexao('numeric-pairing'), error => error.retryAfterSeconds === 30);
    assert.ok(!logs.join('\n').includes('12345678'));
    assert.equal(safeHeaders(new Headers({ 'retry-after': '12345678' }))['retry-after'], null);
  });
  await t.test('temporary route cannot return injected extra diagnostic fields', () => {
    const value = routeDiagnostic({ upstreamDiagnostic: { httpStatus: 429, statusText: raw, message: pairing,
      endpoint: '/webhook/set/barbearia-6', method: 'POST', headers: { server: raw, 'x-request-id': pairing, unexpected: raw },
      body: raw, private: pairing, stack: raw }, rateLimitSource: 'upstream' });
    noSecrets(value); assert.equal(value.httpStatus, 429); assert.equal(value.method, 'POST');
    assert.equal(value.private, undefined); assert.equal(value.stack, undefined);
    noSecrets(routeDiagnostic({ retryAfterSeconds: raw, diagnostic: { httpStatus: 12345678 }, message: pairing }));
  });
});
