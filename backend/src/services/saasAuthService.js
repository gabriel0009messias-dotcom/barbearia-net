const env = require('../config/env');
const salonRepository = require('../repositories/salonRepository');
const userRepository = require('../repositories/saasUserRepository');
const subscriptionRepository = require('../repositories/saasSubscriptionRepository');
const { hashPassword, comparePassword } = require('../utils/password');
const { signJwt } = require('../utils/jwt');
const { createError, requiredString, email: validateEmail, optionalString } = require('./validationService');

function slugify(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function register(payload) {
  const salonName = requiredString(payload.salonName, 'Nome do salao');
  const ownerName = requiredString(payload.ownerName, 'Nome do administrador');
  const userEmail = validateEmail(payload.email);
  const password = requiredString(payload.password, 'Senha');

  if (password.length < 8) {
    throw createError('Senha deve ter pelo menos 8 caracteres.');
  }

  const existingUser = await userRepository.findByEmail(userEmail);
  if (existingUser) {
    throw createError('Ja existe uma conta com este email.', 409);
  }

  const slugBase = slugify(payload.slug || salonName);
  const existingSalon = await salonRepository.findBySlug(slugBase);
  const slug = existingSalon ? `${slugBase}-${Date.now()}` : slugBase;

  const salon = await salonRepository.create({
    name: salonName,
    slug,
    ownerName,
    email: userEmail,
    phone: optionalString(payload.phone),
    openingTime: payload.openingTime,
    closingTime: payload.closingTime,
    lunchStart: payload.lunchStart,
    lunchEnd: payload.lunchEnd,
    workingDays: Array.isArray(payload.workingDays) ? payload.workingDays : undefined,
  });

  const passwordHash = await hashPassword(password);
  const user = await userRepository.create({
    salonId: salon.id,
    name: ownerName,
    email: userEmail,
    passwordHash,
    role: 'OWNER',
  });

  const subscription = await subscriptionRepository.create({
    salonId: salon.id,
    status: 'PENDING',
    amount: Number((env.defaultPlanAmountCents / 100).toFixed(2)),
    startDate: new Date().toISOString().slice(0, 10),
    nextPaymentDate: new Date().toISOString().slice(0, 10),
  });

  const token = signJwt({
    sub: user.id,
    salonId: user.salon_id,
    role: user.role,
  });

  return {
    token,
    user: {
      id: user.id,
      salon_id: user.salon_id,
      name: user.name,
      email: user.email,
      role: user.role,
    },
    salon,
    subscription,
  };
}

async function login(payload) {
  const userEmail = validateEmail(payload.email);
  const password = requiredString(payload.password, 'Senha');
  const user = await userRepository.findByEmail(userEmail);

  if (!user) {
    throw createError('Email ou senha invalidos.', 401);
  }

  const validPassword = await comparePassword(password, user.password_hash);
  if (!validPassword) {
    throw createError('Email ou senha invalidos.', 401);
  }

  const token = signJwt({
    sub: user.id,
    salonId: user.salon_id,
    role: user.role,
  });

  return {
    token,
    user: {
      id: user.id,
      salon_id: user.salon_id,
      name: user.name,
      email: user.email,
      role: user.role,
    },
  };
}

module.exports = {
  register,
  login,
};
