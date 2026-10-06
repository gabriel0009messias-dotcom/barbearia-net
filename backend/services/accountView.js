// Public contract for /barbeiro/me. Never spread database records into this view.
const ACCOUNT_FIELDS = Object.freeze([
  'id', 'barbearia_nome', 'valor_plano', 'valor_mensal',
  'dias_funcionamento', 'horario_abertura', 'horario_almoco_inicio',
  'horario_almoco_fim', 'horario_fechamento', 'localizacao_cidade',
  'localizacao_rua', 'localizacao_referencia',
]);

function pick(value, fields) {
  return Object.fromEntries(fields.filter(key => Object.hasOwn(value || {}, key))
    .map(key => [key, value[key]]));
}

function accountView(account) {
  return {
    ...pick(account, ACCOUNT_FIELDS),
    acesso: {
      ...pick(account.acesso, ['liberado', 'status', 'motivo', 'mensagem']),
      trial: pick(account.acesso?.trial, ['status', 'startedAt', 'endsAt', 'daysRemaining']),
    },
    // The legacy panel still reads these payment and configuration fields.
    pix: null,
    lembrete_pagamento: account.lembrete_pagamento
      ? pick(account.lembrete_pagamento, ['mensagem']) : null,
    servicos: (account.servicos || []).map(service => pick(service, ['id', 'nome', 'preco'])),
  };
}

module.exports = { ACCOUNT_FIELDS, accountView };
