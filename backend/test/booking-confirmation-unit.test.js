const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeBrazilianDestination, classifyBrazilianDestination } = require('../services/whatsapp/phone');
const { buildBookingConfirmation } = require('../services/bookingConfirmation');

for (const phone of ['(75) 99999-9999', '75 99999-9999', '75999999999', '+55 75 99999-9999', '5575999999999']) {
  test('booking confirmation: canonical Brazilian destination ' + phone, () => assert.equal(normalizeBrazilianDestination(phone), '5575999999999'));
}
for (const phone of ['(55) 99999-9999', '55999999999', '+55 55 99999-9999', '5555999999999']) {
  test('booking confirmation: DDD 55 is not confused with the country code ' + phone, () => assert.equal(normalizeBrazilianDestination(phone), '5555999999999'));
}
for (const phone of ['', null, 75999999999, '99999-9999', '00000000000', '5510999999999', '+1 2025550123', '+75 99999-9999', '+55 99999-9999', 'abc75999999999', '75+999999999', '75 89999-9999']) {
  test('booking confirmation: unsafe destination is refused ' + String(phone), () => assert.equal(normalizeBrazilianDestination(phone), null));
}
const snapshot = () => ({ cliente: 'Gabriel', estabelecimento: 'Studio Exemplo', servico: 'Massagem', preco: 30, data: '2026-10-20', hora: '14:00' });
for (const [input, state, destination] of [
  ['+55 99999-9999', 'invalid', null], ['+55 9999-9999', 'invalid', null], ['055 99999-9999', 'invalid', null],
  ['55 99999-9999', 'routable', '5555999999999'], ['+5575999999999', 'routable', '5575999999999'],
  ['', 'missing', null], [null, 'missing', null], [undefined, 'missing', null], [75999999999, 'invalid', null],
]) test('CONF-AUD-01: original field decision ' + String(input), () => {
  assert.deepEqual(classifyBrazilianDestination(input), { state, destination });
});
for (const [label, pattern] of [['cliente', /Olá, Gabriel!/], ['estabelecimento', /Estabelecimento: Studio Exemplo/], ['serviço', /Serviço: Massagem/], ['preço', /Valor: R\$\s30,00/], ['data', /Data: 20\/10\/2026/], ['horário', /Horário: 14:00/]]) {
  test('booking confirmation: message contains ' + label, () => assert.match(buildBookingConfirmation(snapshot()), pattern));
}
test('booking confirmation: zero and decimal historical prices are not replaced', () => {
  assert.match(buildBookingConfirmation({ ...snapshot(), preco: '35.20' }), /R\$\s35,20/);
  assert.match(buildBookingConfirmation({ ...snapshot(), preco: 0 }), /R\$\s0,00/);
});
test('booking confirmation: pure formatter does not mutate snapshots or include internal data', () => {
  const value = Object.freeze({ ...snapshot(), appointment_id: '8675309', assinatura_id: '98765', token: 'PRIVATE_TOKEN', apikey: 'PRIVATE_APIKEY', url: 'https://admin.invalid' });
  const message = buildBookingConfirmation(value);
  for (const secret of ['8675309', '98765', 'PRIVATE_TOKEN', 'PRIVATE_APIKEY', 'admin.invalid']) assert.ok(!message.includes(secret));
  assert.equal(message, buildBookingConfirmation(value));
  assert.ok(!/barbearia|barbeiro|corte/i.test(message));
});
test('booking confirmation: names are plain text, no HTML or multiline injection', () => {
  const message = buildBookingConfirmation({ ...snapshot(), cliente: '<img src=x onerror=alert(1)>Gabriel\nOutra linha', servico: '<b>Massagem</b>', estabelecimento: '<script>bad()</script>Studio' });
  assert.ok(!/[<>]/.test(message));
  assert.match(message, /Olá, Gabriel Outra linha!/);
  assert.match(message, /Serviço: Massagem/);
});
for (const extra of [{ preco: -1 }, { preco: 1.005 }, { data: '2026-02-30' }, { hora: '24:00' }, { cliente: '' }, { servico: '' }, { estabelecimento: '' }]) {
  test('booking confirmation: invalid snapshot fails with a fixed message ' + JSON.stringify(extra), () => assert.throws(() => buildBookingConfirmation({ ...snapshot(), ...extra }), { message: 'Invalid booking confirmation snapshot.' }));
}
