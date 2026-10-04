const { test } = require('node:test');
const assert = require('node:assert/strict');
const api = require('../evolutionApi');

function fixture(t, name) {
  process.env.EVOLUTION_API_URL = `https://${name}.test`;
  process.env.EVOLUTION_API_KEY = 'synthetic-key';
  let now = Date.now();
  const state = { value: 'close', code: null, fault: null, starts: 0, paths: [] };
  t.mock.method(Date, 'now', () => now);
  for (const level of ['info', 'error']) t.mock.method(console, level, () => {});
  t.mock.method(global, 'fetch', async url => {
    const path = new URL(url).pathname; state.paths.push(path);
    assert.ok(!/delete|logout|restart|create/.test(path));
    if (state.fault) return Response.json({}, { status: state.fault, headers: { 'Retry-After': '120' } });
    if (path.includes('/connectionState/')) return Response.json({ instance: { state: state.value } });
    assert.match(path, /\/instance\/connect\//);
    if (state.value === 'close') { state.starts++; state.value = 'connecting'; }
    if (state.value === 'open') return Response.json({ instance: { state: 'open' } });
    return Response.json(state.code || { count: 0 });
  });
  return { state, tick: ms => { now += ms; } };
}

test('QR tardio: recuperacao single-flight le connect enquanto connecting, sem reiniciar socket', async t => {
  const { state } = fixture(t, 'recover-qr');
  await api.conectarInstancia('barbearia-6');
  state.code = { base64: 'data:image/png;base64,c3ludGhldGlj' };
  const results = await Promise.all([api.recuperarCodigoConexao('barbearia-6'), api.recuperarCodigoConexao('barbearia-6')]);
  assert.equal(results[0].base64, state.code.base64); assert.deepEqual(results[0], results[1]);
  assert.equal(state.starts, 1);
  assert.equal(state.paths.filter(p => p.includes('/connect/')).length, 2);
  await api.recuperarCodigoConexao('barbearia-6'); assert.equal(state.starts, 1);
});

test('QR ausente: recuperacoes limitadas, timeout 60s e retry explicito preservam instancia', async t => {
  const { state, tick } = fixture(t, 'recover-missing');
  await api.conectarInstancia('barbearia-6');
  for (let i = 0; i < 5; i++) { await api.recuperarCodigoConexao('barbearia-6'); tick(15001); }
  assert.equal(state.paths.filter(p => p.includes('/connect/')).length, 4, 'inicio + tres leituras');
  assert.equal(api.progressoConexao('barbearia-6', 'connecting').connectionTimedOut, true);
  state.code = { base64: 'data:image/png;base64,c3ludGhldGlj' };
  await api.recuperarCodigoConexao('barbearia-6', '', { explicit: true });
  assert.equal(state.starts, 1); assert.ok(api.obterCodigoConexao('barbearia-6'));
});

test('QR expirado: recupera QR atual sem novo socket; close confirmado permite um retry solicitado', async t => {
  const { state, tick } = fixture(t, 'recover-expired');
  state.code = { base64: 'data:image/png;base64,YQ==' };
  await api.conectarInstancia('barbearia-6'); tick(60001);
  assert.equal(api.obterCodigoConexao('barbearia-6'), null);
  state.code = { base64: 'data:image/png;base64,Yg==' };
  await api.recuperarCodigoConexao('barbearia-6', '', { explicit: true });
  assert.equal(api.obterCodigoConexao('barbearia-6').base64, state.code.base64); assert.equal(state.starts, 1);
  tick(60001); state.value = 'close';
  await Promise.all([api.recuperarCodigoConexao('barbearia-6', '', { explicit: true }), api.recuperarCodigoConexao('barbearia-6', '', { explicit: true })]);
  assert.equal(state.starts, 2);
});

test('pairing: number na query oficial, recuperacao tardia e troca de metodo bloqueada durante connecting', async t => {
  const { state } = fixture(t, 'recover-pairing');
  await api.conectarInstancia('barbearia-6', '5511999999999');
  state.code = { pairingCode: 'ABCD1234', base64: 'data:image/png;base64,YQ==' };
  const recovered = await api.recuperarCodigoConexao('barbearia-6', '5511999999999');
  assert.equal(recovered.pairingCode, 'ABCD1234'); assert.equal(state.starts, 1);
  await assert.rejects(api.recuperarCodigoConexao('barbearia-6', ''), { code: 'WHATSAPP_METHOD_PENDING' });
});

test('429 e indisponibilidade na recuperacao nao autorizam conectar novamente', async t => {
  const { state, tick } = fixture(t, 'recover-limited');
  await api.conectarInstancia('barbearia-6'); tick(60001);
  state.fault = 429;
  await assert.rejects(api.recuperarCodigoConexao('barbearia-6', '', { explicit: true }), { retryAfterSeconds: 120 });
  const count = state.paths.length;
  await assert.rejects(api.recuperarCodigoConexao('barbearia-6', '', { explicit: true }), { rateLimitSource: 'local_cooldown' });
  assert.equal(state.paths.length, count); assert.equal(state.starts, 1);
  tick(120001); state.fault = 503;
  await assert.rejects(api.recuperarCodigoConexao('barbearia-6', '', { explicit: true }), { code: 'EVOLUTION_OFFLINE' });
  assert.equal(state.starts, 1);
});
