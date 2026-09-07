const { ROLES } = require('../config/constants');
const userRepository = require('../repositories/userRepository');
const clientRepository = require('../repositories/clientRepository');
const subscriptionRepository = require('../repositories/subscriptionRepository');
const planRepository = require('../repositories/planRepository');
const { hashPassword, comparePassword } = require('../utils/password');
const { signJwt } = require('../utils/jwt');
const { addMonths, toIsoDate } = require('../utils/date');
const { computeAccessStatus, computeGraceUntil } = require('../utils/subscription');
const mercadoPagoService = require('./mercadoPagoService');

async function registerClient(payload) {
  const existingUser = await userRepository.findByEmail(payload.email);
  if (existingUser) {
    const error = new Error('Ja existe uma conta com este email.');
    error.statusCode = 409;
    throw error;
  }

  const plan = await planRepository.getDefaultPlan();
  const client = await clientRepository.createClient({
    companyName: payload.companyName,
    ownerName: payload.ownerName,
    document: payload.document,
    email: payload.email,
    phone: payload.phone,
  });

  const passwordHash = await hashPassword(payload.password);
  const user = await userRepository.createClientUser({
    clientId: client.id,
    name: payload.ownerName,
    email: payload.email,
    phone: payload.phone,
    passwordHash,
    role: ROLES.CLIENT,
  });

  const externalReference = `client:${client.id}`;
  const preapproval = await mercadoPagoService.createPreapproval({
    reason: plan.nome,
    payerEmail: payload.email,
    externalReference,
    amountCents: plan.valor_centavos,
    backUrl: `${require('../config/env').appUrl}/cliente/dashboard`,
  });

  const nextDueDate = preapproval.next_payment_date
    ? toIsoDate(preapproval.next_payment_date)
    : toIsoDate(addMonths(new Date(), 1));

  const subscription = await subscriptionRepository.createSubscription({
    clientId: client.id,
    planId: plan.id,
    externalReference,
    mercadoPagoPreapprovalId: preapproval.id,
    checkoutUrl: preapproval.init_point,
    status: preapproval.status || 'pending',
    billingStatus: preapproval.status || 'pending',
    accessStatus: computeAccessStatus({ next_due_date: nextDueDate, status: preapproval.status, billing_status: preapproval.status }),
    dueDay: new Date(nextDueDate).getDate(),
    graceDays: 4,
    extraGraceDays: 0,
    currentPeriodStart: toIsoDate(new Date()),
    currentPeriodEnd: nextDueDate,
    nextDueDate,
    graceUntil: computeGraceUntil({ next_due_date: nextDueDate, grace_days: 4 }),
    metadata: {
      initPoint: preapproval.init_point,
      payerEmail: payload.email,
    },
  });

  const token = signJwt({
    sub: user.id,
    role: user.papel,
    clientId: client.id,
    subscriptionId: subscription.id,
  });

  return { client, user, subscription, token };
}

async function login(email, password) {
  const user = await userRepository.findByEmail(email);
  if (!user || !user.ativo) {
    const error = new Error('Email ou senha invalidos.');
    error.statusCode = 401;
    throw error;
  }

  const valid = await comparePassword(password, user.senha_hash);
  if (!valid) {
    const error = new Error('Email ou senha invalidos.');
    error.statusCode = 401;
    throw error;
  }

  await userRepository.updateLastLogin(user.id);

  const token = signJwt({
    sub: user.id,
    role: user.papel,
    clientId: user.cliente_id,
  });

  return { user, token };
}

async function changePassword(userId, currentPassword, nextPassword) {
  const user = await userRepository.findById(userId);
  if (!user) {
    const error = new Error('Usuario nao encontrado.');
    error.statusCode = 404;
    throw error;
  }

  const valid = await comparePassword(currentPassword, user.senha_hash);
  if (!valid) {
    const error = new Error('Senha atual invalida.');
    error.statusCode = 400;
    throw error;
  }

  const passwordHash = await hashPassword(nextPassword);
  await userRepository.updatePassword(user.id, passwordHash);
}

module.exports = {
  registerClient,
  login,
  changePassword,
};
