const repository = require('../repositories/blockedTimeRepository');
const { createError, date, time, optionalString, uuid } = require('./validationService');

function normalizePayload(payload) {
  const startTime = time(payload.startTime, 'Horario inicial');
  const endTime = time(payload.endTime, 'Horario final');

  if (endTime <= startTime) {
    throw createError('Horario final deve ser maior que horario inicial.');
  }

  return {
    professionalId: payload.professionalId ? uuid(payload.professionalId, 'Profissional') : null,
    date: date(payload.date),
    startTime,
    endTime,
    reason: optionalString(payload.reason),
  };
}

async function list(salonId, filters) {
  return repository.listBySalonId(salonId, filters.date);
}

async function create(salonId, payload) {
  return repository.create(salonId, normalizePayload(payload));
}

async function remove(salonId, id) {
  await repository.remove(salonId, id);
}

module.exports = {
  list,
  create,
  remove,
};
