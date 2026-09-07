const repository = require('../repositories/saasClientRepository');
const { createError, requiredString, optionalString } = require('./validationService');

function normalizePayload(payload) {
  return {
    name: requiredString(payload.name, 'Nome'),
    phone: optionalString(payload.phone),
    email: optionalString(payload.email),
    notes: optionalString(payload.notes),
  };
}

async function list(salonId) {
  return repository.listBySalonId(salonId);
}

async function create(salonId, payload) {
  return repository.create(salonId, normalizePayload(payload));
}

async function update(salonId, id, payload) {
  const updated = await repository.update(salonId, id, normalizePayload(payload));
  if (!updated) {
    throw createError('Cliente nao encontrado.', 404);
  }

  return updated;
}

async function remove(salonId, id) {
  const existing = await repository.findById(salonId, id);
  if (!existing) {
    throw createError('Cliente nao encontrado.', 404);
  }

  await repository.remove(salonId, id);
}

module.exports = {
  list,
  create,
  update,
  remove,
};
