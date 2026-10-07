const { test } = require('node:test');
const assert = require('node:assert/strict');
const { subscriptionView } = require('../services/subscriptionView');
const { servicePrice, signupPassword, legacyHours, loginIdentity } = require('../services/signupInput');
const { historicalCents } = require('../services/finance');
const { serviceInput, validateHours, effectiveHours } = require('../services/studiofy');

test('Conta: allowlist exclui material sensível e novos campos internos, inclusive objetos aninhados', () => {
  const privateKeys = ['senha', 'senha_hash', 'senha_salt', 'hash', 'salt', 'token',
    'whatsapp_bridge_token', 'api_key', 'secret', 'credentials', 'mercado_last_payload',
    'notification_history', 'future_private_field'];
  const row = Object.fromEntries(privateKeys.map(key => [key, { private: 'synthetic-only' }]));
  Object.assign(row, { id: 1, barbearia_nome: 'Studio', email: 'owner@example.test',
    trial_ends_at: new Date('2030-01-01T00:00:00Z'), observacoes: { secret: 'synthetic-only' } });
  assert.deepEqual(subscriptionView(row), { id: 1, barbearia_nome: 'Studio',
    email: 'owner@example.test', trial_ends_at: '2030-01-01T00:00:00.000Z' });
  for (const key of privateKeys) assert.equal(Object.hasOwn(subscriptionView(row), key), false);
  assert.equal(Object.hasOwn(row, 'senha_hash'), true, 'Projeção não altera o registro usado pela autenticação');
});

for (const value of [0, '0.00', 1, '1.01', 35.2, '35.20', 0.29, 99999.99, 100000]) {
  test(`Serviço: preço válido ${value} permanece compatível com Financeiro`, async () => {
    const price = servicePrice(value);
    assert.equal(historicalCents(price), historicalCents(value));
    assert.equal((await serviceInput({ nome: 'Serviço', preco: value, duracao: 30 })).preco, price);
  });
}

for (const [label, value] of [
  ['1.005', 1.005], ['microsubcentavo', 1.000000001], ['2.675', 2.675],
  ['NaN', NaN], ['Infinity', Infinity], ['-Infinity', -Infinity],
  ['null', null], ['undefined', undefined], ['boolean', false], ['array', [1]], ['object', {}],
  ['negative', -1], ['over max', 100000.01], ['comma', '1,20'], ['currency', 'R$ 1.20'],
  ['empty', ''], ['spaces', ' 1.20 '], ['exponential string', '1e2'],
  ['three places', '1.000'], ['malformed', '1.2.3'], ['nonfinite string', 'Infinity'],
]) test(`Serviço: ${label} é recusado sem arredondamento ou coerção`, async () => {
  assert.throws(() => servicePrice(value), error => error.statusCode === 400);
  await assert.rejects(serviceInput({ nome: 'Serviço', preco: value, duracao: 30 }), error => error.statusCode === 400);
});

test('Cadastro: senha nova exige 8–128 caracteres úteis, sem modificar a senha', () => {
  for (const value of ['12345678', 'synthetic-password', ' password ', 'a'.repeat(128)]) {
    assert.equal(signupPassword(value), value);
  }
  for (const value of ['1234', ' '.repeat(8), ' 1234567 ', 'a'.repeat(129), 12345678, {}, null, 'abcd\n1234']) {
    assert.throws(() => signupPassword(value), error => error.statusCode === 400);
  }
});

test('Cadastro: horários legados válidos, sem almoço e dias fechados preservam o funcionamento', () => {
  const hours = legacyHours({ diasFuncionamento: [6, '1', 1], horarioAbertura: '08:00',
    horarioAlmocoInicio: '12:00', horarioAlmocoFim: '12:00', horarioFechamento: '18:00' });
  assert.equal(hours.days, '1,6');
  assert.equal(hours.opening, '08:00');
  assert.equal(legacyHours({ diasFuncionamento: [] }).days, '');
  assert.deepEqual(effectiveHours({ dias_funcionamento: '', horario_abertura: '08:00',
    horario_almoco_inicio: '12:00', horario_almoco_fim: '13:00', horario_fechamento: '18:00' }),
    Array.from({ length: 7 }, () => []));
});

for (const [label, body] of [
  ['25:99', { horarioAbertura: '25:99' }], ['24:00', { horarioFechamento: '24:00' }],
  ['minutes', { horarioAlmocoInicio: '12:60' }], ['format', { horarioAbertura: '8:00' }],
  ['array', { horarioAbertura: ['08:00'] }], ['empty', { horarioAbertura: '' }],
  ['reversed', { horarioAbertura: '18:00', horarioFechamento: '08:00' }],
  ['lunch overlap', { horarioAlmocoInicio: '14:00', horarioAlmocoFim: '13:00' }],
  ['lunch outside', { horarioAlmocoFim: '19:00' }], ['invalid days', { diasFuncionamento: [7] }],
  ['day partial', { diasFuncionamento: ['1x'] }], ['days type', { diasFuncionamento: '1,2' }],
]) test(`Cadastro: horário/dia inválido ${label} retorna validação de backend`, () => {
  assert.throws(() => legacyHours(body), error => error.statusCode === 400);
});

test('Configuração semanal: backend rejeita horários impossíveis, sobreposição e tipos manipulados', () => {
  const week = intervals => Array.from({ length: 7 }, () => intervals);
  assert.deepEqual(validateHours(week([['08:00', '18:00']])), week([['08:00', '18:00']]));
  for (const periods of [[['25:99', '18:00']], [[['08:00'], '18:00']],
    [['08:00', '12:00'], ['11:30', '18:00']], [['18:00', '08:00']]]) {
    assert.throws(() => validateHours(week(periods)), error => error.statusCode === 400);
  }
});

test('Login: e-mail e telefones equivalentes usam identidade canônica sem alterar senha', () => {
  assert.equal(loginIdentity(' Owner@Example.Test '), 'owner@example.test');
  assert.equal(loginIdentity('+55 (11) 99999-8888'), '11999998888');
  assert.equal(loginIdentity('11999998888'), '11999998888');
  assert.throws(() => loginIdentity({}), error => error.statusCode === 400);
  for (const value of ['not-a-phone', '   ', '1234', 'invalid@', 'abc11999998888']) {
    assert.throws(() => loginIdentity(value), error => error.statusCode === 400);
  }
});
