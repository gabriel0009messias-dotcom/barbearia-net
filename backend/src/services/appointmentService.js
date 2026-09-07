const appointmentRepository = require('../repositories/appointmentRepository');
const blockedTimeRepository = require('../repositories/blockedTimeRepository');
const salonRepository = require('../repositories/salonRepository');
const serviceRepository = require('../repositories/serviceRepository');
const professionalRepository = require('../repositories/professionalRepository');
const clientRepository = require('../repositories/saasClientRepository');
const { createError, date, time, uuid, optionalString } = require('./validationService');

function toMinutes(value) {
  const [hours, minutes] = String(value).split(':').map(Number);
  return hours * 60 + minutes;
}

function toTime(totalMinutes) {
  const hours = String(Math.floor(totalMinutes / 60)).padStart(2, '0');
  const minutes = String(totalMinutes % 60).padStart(2, '0');
  return `${hours}:${minutes}`;
}

async function buildPayload(salonId, payload) {
  const clientId = uuid(payload.clientId, 'Cliente');
  const professionalId = uuid(payload.professionalId, 'Profissional');
  const serviceId = uuid(payload.serviceId, 'Servico');
  const appointmentDate = date(payload.date);
  const startTime = time(payload.startTime, 'Horario inicial');

  const [client, professional, service] = await Promise.all([
    clientRepository.findById(salonId, clientId),
    professionalRepository.findById(salonId, professionalId),
    serviceRepository.findById(salonId, serviceId),
  ]);

  if (!client) {
    throw createError('Cliente nao encontrado.', 404);
  }

  if (!professional) {
    throw createError('Profissional nao encontrado.', 404);
  }

  if (!service) {
    throw createError('Servico nao encontrado.', 404);
  }

  const endMinutes = toMinutes(startTime) + Number(service.duration_minutes);
  return {
    clientId,
    professionalId,
    serviceId,
    date: appointmentDate,
    startTime,
    endTime: toTime(endMinutes),
    status: payload.status || 'CONFIRMED',
    notes: optionalString(payload.notes),
  };
}

async function ensureNoConflicts(salonId, payload, ignoreId = null) {
  const salon = await salonRepository.findById(salonId);
  if (!salon) {
    throw createError('Salao nao encontrado.', 404);
  }

  const dayOfWeek = new Date(`${payload.date}T00:00:00`).getDay();
  const workingDays = Array.isArray(salon.working_days) ? salon.working_days : JSON.parse(salon.working_days || '[]');

  if (!workingDays.includes(dayOfWeek)) {
    throw createError('O salao nao atende neste dia.');
  }

  if (payload.startTime < salon.opening_time || payload.endTime > salon.closing_time) {
    throw createError('Horario fora do expediente.');
  }

  if (
    salon.lunch_start &&
    salon.lunch_end &&
    payload.startTime < salon.lunch_end &&
    payload.endTime > salon.lunch_start
  ) {
    throw createError('Horario indisponivel durante o intervalo.');
  }

  const blockedTimes = await blockedTimeRepository.listBySalonId(salonId, payload.date);
  const overlapsBlocked = blockedTimes.some((item) => {
    if (item.professional_id && String(item.professional_id) !== String(payload.professionalId)) {
      return false;
    }

    return item.start_time < payload.endTime && item.end_time > payload.startTime;
  });

  if (overlapsBlocked) {
    throw createError('Horario bloqueado para agendamento.');
  }

  const conflicts = await appointmentRepository.findConflicts(salonId, payload, ignoreId);
  if (conflicts.length) {
    throw createError('Ja existe um agendamento conflitante para esse profissional.', 409);
  }
}

async function list(salonId, filters) {
  return appointmentRepository.listBySalonId(salonId, filters);
}

async function create(salonId, payload) {
  const normalized = await buildPayload(salonId, payload);
  await ensureNoConflicts(salonId, normalized);
  return appointmentRepository.create(salonId, normalized);
}

async function update(salonId, id, payload) {
  const existing = await appointmentRepository.findById(salonId, id);
  if (!existing) {
    throw createError('Agendamento nao encontrado.', 404);
  }

  const normalized = await buildPayload(salonId, payload);
  await ensureNoConflicts(salonId, normalized, id);
  return appointmentRepository.update(salonId, id, normalized);
}

async function cancel(salonId, id) {
  const existing = await appointmentRepository.findById(salonId, id);
  if (!existing) {
    throw createError('Agendamento nao encontrado.', 404);
  }

  await appointmentRepository.cancel(salonId, id);
}

async function getAvailability(salonId, query) {
  const salon = await salonRepository.findById(salonId);
  if (!salon) {
    throw createError('Salao nao encontrado.', 404);
  }

  const appointmentDate = date(query.date);
  const professionalId = uuid(query.professionalId, 'Profissional');
  const serviceId = uuid(query.serviceId, 'Servico');
  const service = await serviceRepository.findById(salonId, serviceId);

  if (!service) {
    throw createError('Servico nao encontrado.', 404);
  }

  const blockedTimes = await blockedTimeRepository.listBySalonId(salonId, appointmentDate);
  const appointments = await appointmentRepository.listBySalonId(salonId, { date: appointmentDate });
  const slots = [];

  for (
    let cursor = toMinutes(salon.opening_time);
    cursor + Number(service.duration_minutes) <= toMinutes(salon.closing_time);
    cursor += 30
  ) {
    const startTime = toTime(cursor);
    const endTime = toTime(cursor + Number(service.duration_minutes));

    if (salon.lunch_start && salon.lunch_end && startTime < salon.lunch_end && endTime > salon.lunch_start) {
      continue;
    }

    const blocked = blockedTimes.some((item) => {
      if (item.professional_id && String(item.professional_id) !== String(professionalId)) {
        return false;
      }

      return item.start_time < endTime && item.end_time > startTime;
    });

    if (blocked) {
      continue;
    }

    const conflict = appointments.some((item) => {
      if (String(item.professional_id) !== String(professionalId)) {
        return false;
      }

      return ['PENDING', 'CONFIRMED', 'COMPLETED'].includes(item.status) && item.start_time < endTime && item.end_time > startTime;
    });

    if (!conflict) {
      slots.push({ start_time: startTime, end_time: endTime });
    }
  }

  return {
    date: appointmentDate,
    professional_id: professionalId,
    service_id: serviceId,
    slots,
  };
}

module.exports = {
  list,
  create,
  update,
  cancel,
  getAvailability,
};
