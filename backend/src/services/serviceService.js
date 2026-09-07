const repository = require('../repositories/serviceRepository');
const { createError, requiredString, positiveNumber, integer } = require('./validationService');

function normalizePayload(payload) {
  return {
    name: requiredString(payload.name, 'Nome'),
    description: String(payload.description || '').trim() || null,
    price: positiveNumber(payload.price, 'Preco'),
    durationMinutes: integer(payload.durationMinutes, 'Duracao'),
    active: payload.active !== false,
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
    throw createError('Servico nao encontrado.', 404);
  }

  return updated;
}

async function remove(salonId, id) {
  const existing = await repository.findById(salonId, id);
  if (!existing) {
    throw createError('Servico nao encontrado.', 404);
  }

  await repository.remove(salonId, id);
}

module.exports = {
  list,
  create,
  update,
  remove,
};
