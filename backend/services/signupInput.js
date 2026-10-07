const { historicalCents } = require('./finance');
const { normalizePhone } = require('./trial');
const invalid = message => { throw Object.assign(new Error(message), { statusCode: 400 }); };

function servicePrice(value) {
  if (!['string', 'number'].includes(typeof value) ||
      (typeof value === 'number' && !Number.isFinite(value)) ||
      !/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(String(value))) {
    invalid('Informe um preço não negativo, com no máximo duas casas decimais.');
  }
  const cents = historicalCents(value);
  if (cents === null || cents > 10000000) invalid('O preço deve estar entre R$ 0,00 e R$ 100.000,00.');
  return cents / 100;
}

function signupPassword(value) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 128 ||
      value.trim().length < 8 || /[\u0000-\u001f\u007f]/.test(value)) {
    invalid('Use uma senha de 8 a 128 caracteres, sem contar espaços nas extremidades.');
  }
  // Preserve the exact password; normalization must never change credentials.
  return value;
}

function phoneIdentitySql(column) {
  if (!/^[a-z_]+(?:\.[a-z_]+)?$/.test(column)) throw new Error('Invalid internal column.');
  const digits = `regexp_replace(COALESCE(${column},''), '[^0-9]', '', 'g')`;
  return `(CASE WHEN length(${digits}) IN (12,13) AND left(${digits},2)='55' THEN substr(${digits},3) ELSE ${digits} END)`;
}

function loginIdentity(value) {
  if (typeof value !== 'string') invalid('Informe e-mail ou telefone válido.');
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 254) invalid('Informe e-mail ou telefone válido.');
  if (trimmed.includes('@')) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) invalid('Informe e-mail ou telefone válido.');
    return trimmed.toLowerCase();
  }
  const phone = normalizePhone(trimmed);
  if (!/^[+()\d.\s-]+$/.test(trimmed) || !/^\d{10,15}$/.test(phone)) invalid('Informe e-mail ou telefone válido.');
  return phone;
}

function legacyHours(body, current = {}) {
  const fields = [
    ['horarioAbertura', 'horario_abertura', '08:00'],
    ['horarioAlmocoInicio', 'horario_almoco_inicio', '12:00'],
    ['horarioAlmocoFim', 'horario_almoco_fim', '13:00'],
    ['horarioFechamento', 'horario_fechamento', '18:00'],
  ];
  const values = fields.map(([input, stored, fallback]) =>
    body[input] === undefined ? (current[stored] ?? fallback) : body[input]);
  if (!values.every(v => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v)) ||
      !(values[0] < values[3] && values[0] <= values[1] &&
        values[1] <= values[2] && values[2] <= values[3])) {
    invalid('Informe horários HH:MM válidos, com abertura antes do fechamento e intervalo de almoço dentro do expediente.');
  }
  const days = body.diasFuncionamento === undefined
    ? (current.dias_funcionamento === undefined ? [1, 2, 3, 4, 5, 6]
      : String(current.dias_funcionamento).split(',').filter(v => v !== '').map(Number))
    : body.diasFuncionamento;
  if (!Array.isArray(days) || !days.every(d => ['string', 'number'].includes(typeof d) && /^[0-6]$/.test(String(d)))) {
    invalid('Informe dias de funcionamento entre 0 e 6.');
  }
  return {
    days: [...new Set(days.map(Number))].sort((a, b) => a - b).join(','),
    opening: values[0], lunchStart: values[1], lunchEnd: values[2], closing: values[3],
  };
}

module.exports = { servicePrice, signupPassword, phoneIdentitySql, loginIdentity, legacyHours };
