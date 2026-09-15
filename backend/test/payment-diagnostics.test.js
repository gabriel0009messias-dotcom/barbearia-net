const { test } = require('node:test');
const assert = require('node:assert/strict');
const { redact, diagnose } = require('../services/payments/diagnostics');

test('diagnostico remove dados pessoais e segredos inclusive em mensagens da API', () => {
  const before = { ...process.env };
  process.env.MERCADO_PAGO_ACCESS_TOKEN = 'private-access-value';
  process.env.MERCADO_PAGO_WEBHOOK_SECRET = 'private-webhook-value';
  try {
    const result = redact({
      items: [{ title: 'Plano Profissional - 30 dias', unit_price: 65, quantity: 1, currency_id: 'BRL' }],
      nested: [{ access_token: 'secret', email: 'buyer@example.test', identification: { number: '12345678901' } }],
      message: 'private-access-value private-webhook-value APP_USR-1234-abcdef buyer@example.test',
    });
    assert.equal(result.items[0].unit_price, 65);
    assert.equal(result.nested[0].identification, '[REDACTED]');
    assert.doesNotMatch(JSON.stringify(result), /private-|APP_USR|buyer@|12345678901/);
  } finally {
    for (const key of ['MERCADO_PAGO_ACCESS_TOKEN', 'MERCADO_PAGO_WEBHOOK_SECRET']) {
      if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key];
    }
  }
});

test('diagnostico conserva status e request ID dos erros sem lancar detalhes secretos', async t => {
  const original = process.env.MERCADO_PAGO_ACCESS_TOKEN;
  process.env.MERCADO_PAGO_ACCESS_TOKEN = 'fake-diagnostic-token';
  t.after(() => { if (original === undefined) delete process.env.MERCADO_PAGO_ACCESS_TOKEN; else process.env.MERCADO_PAGO_ACCESS_TOKEN = original; });
  const calls = [];
  t.mock.method(global, 'fetch', async (url, options) => {
    calls.push(String(url));
    assert.equal(options.method, 'GET');
    return Response.json({ error: 'unauthorized', message: 'fake-diagnostic-token' }, { status: 401, headers: { 'x-request-id': 'request-test' } });
  });
  const report = await diagnose({ preference_id: 'existing-preference' });
  assert.equal(calls.length, 3);
  assert.equal(report.preference.status, 401);
  assert.equal(report.preference.requestId, 'request-test');
  assert.equal(report.checks.collectorMatchesCredential, null);
  assert.doesNotMatch(JSON.stringify(report), /fake-diagnostic-token/);
});
