function createError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function requiredString(value, field) {
  if (!String(value || '').trim()) {
    throw createError(`${field} e obrigatorio.`);
  }

  return String(value).trim();
}

function optionalString(value) {
  const normalized = String(value || '').trim();
  return normalized || null;
}

function email(value, field = 'Email') {
  const normalized = requiredString(value, field).toLowerCase();
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized);

  if (!valid) {
    throw createError(`${field} invalido.`);
  }

  return normalized;
}

function positiveNumber(value, field) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    throw createError(`${field} invalido.`);
  }

  return normalized;
}

function integer(value, field) {
  const normalized = Number.parseInt(value, 10);
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw createError(`${field} invalido.`);
  }

  return normalized;
}

function uuid(value, field) {
  const normalized = requiredString(value, field);
  const valid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized);

  if (!valid) {
    throw createError(`${field} invalido.`);
  }

  return normalized;
}

function date(value, field = 'Data') {
  const normalized = requiredString(value, field);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw createError(`${field} invalida.`);
  }

  return normalized;
}

function time(value, field = 'Horario') {
  const normalized = requiredString(value, field);
  if (!/^\d{2}:\d{2}$/.test(normalized)) {
    throw createError(`${field} invalido.`);
  }

  return normalized;
}

module.exports = {
  createError,
  requiredString,
  optionalString,
  email,
  positiveNumber,
  integer,
  uuid,
  date,
  time,
};
