const env = require('../config/env');
const { SUBSCRIPTION_STATUS, PAYMENT_STATUS } = require('../config/constants');
const subscriptionRepository = require('../repositories/subscriptionRepository');
const paymentRepository = require('../repositories/paymentRepository');
const planRepository = require('../repositories/planRepository');
const clientRepository = require('../repositories/clientRepository');
const mercadoPagoService = require('./mercadoPagoService');
const { addMonths, parseIsoDate, toIsoDate } = require('../utils/date');
const { computeAccessStatus, computeGraceUntil } = require('../utils/subscription');

async function getClientWorkspace(clientId) {
  const client = await clientRepository.findById(clientId);
  const subscription = await subscriptionRepository.findByClientId(clientId);
  const payments = subscription ? await paymentRepository.listBySubscriptionId(subscription.id) : [];

  return { client, subscription, payments };
}

async function refreshSubscriptionStatus(subscriptionId) {
  const subscription = await subscriptionRepository.findById(subscriptionId);
  if (!subscription) {
    return null;
  }

  const accessStatus = computeAccessStatus(subscription);
  const graceUntil = computeGraceUntil(subscription);

  return subscriptionRepository.updateSubscription(subscription.id, {
    accessStatus,
    graceUntil,
    blockReason: accessStatus === SUBSCRIPTION_STATUS.BLOCKED ? 'Pagamento em atraso apos a tolerancia.' : null,
  });
}

async function syncSubscriptionFromMercadoPago(subscriptionId) {
  const subscription = await subscriptionRepository.findById(subscriptionId);
  if (!subscription || !subscription.mercado_pago_preapproval_id) {
    return subscription;
  }

  const mpSubscription = await mercadoPagoService.getPreapproval(subscription.mercado_pago_preapproval_id);
  const nextDueDate = mpSubscription.next_payment_date
    ? toIsoDate(mpSubscription.next_payment_date)
    : subscription.next_due_date;
  const accessStatus = computeAccessStatus({
    ...subscription,
    status: mpSubscription.status,
    billing_status: mpSubscription.status,
    next_due_date: nextDueDate,
  });

  return subscriptionRepository.updateSubscription(subscription.id, {
    status: mpSubscription.status,
    billingStatus: mpSubscription.status,
    checkoutUrl: mpSubscription.init_point || subscription.mercado_pago_checkout_url,
    nextDueDate,
    currentPeriodEnd: nextDueDate,
    graceUntil: computeGraceUntil({ next_due_date: nextDueDate, grace_days: subscription.grace_days, extra_grace_days: subscription.extra_grace_days }),
    accessStatus,
    metadata: {
      ...subscription.metadata,
      mercadoPagoSnapshot: mpSubscription,
    },
  });
}

async function createRenewalLink(subscriptionId) {
  const subscription = await syncSubscriptionFromMercadoPago(subscriptionId);
  if (!subscription) {
    return null;
  }

  return {
    checkoutUrl: subscription.mercado_pago_checkout_url,
    subscription,
  };
}

async function registerPaymentFromNotification({ subscription, paymentData, authorizedPaymentData }) {
  const amountSource = paymentData || authorizedPaymentData || {};
  const paymentStatus = paymentData?.status || authorizedPaymentData?.status || PAYMENT_STATUS.PENDING;
  const dueDate = paymentData?.date_of_expiration || authorizedPaymentData?.date || subscription.next_due_date;
  const paidAt = paymentData?.date_approved || authorizedPaymentData?.last_modified || null;
  const amountCents = Math.round(Number(amountSource.transaction_amount || amountSource.amount || subscription.valor_centavos / 100 || env.defaultPlanAmountCents / 100) * 100);
  const nextDueDate = paidAt
    ? toIsoDate(addMonths(parseIsoDate(paidAt) || new Date(), 1))
    : toIsoDate(parseIsoDate(dueDate) || addMonths(new Date(), 1));

  await paymentRepository.createOrUpdatePayment({
    clientId: subscription.cliente_id,
    subscriptionId: subscription.id,
    paymentId: paymentData?.id ? String(paymentData.id) : null,
    authorizedPaymentId: authorizedPaymentData?.id ? String(authorizedPaymentData.id) : null,
    status: paymentStatus,
    statusDetail: paymentData?.status_detail || authorizedPaymentData?.reason || null,
    amountCents,
    currency: amountSource.currency_id || 'BRL',
    dueDate: toIsoDate(parseIsoDate(dueDate) || new Date()),
    paidAt,
    raw: {
      payment: paymentData,
      authorizedPayment: authorizedPaymentData,
    },
  });

  const status = paymentStatus === PAYMENT_STATUS.APPROVED ? SUBSCRIPTION_STATUS.ACTIVE : subscription.status;
  const billingStatus =
    paymentStatus === PAYMENT_STATUS.APPROVED
      ? SUBSCRIPTION_STATUS.ACTIVE
      : paymentStatus === PAYMENT_STATUS.PENDING
        ? SUBSCRIPTION_STATUS.PENDING
        : subscription.billing_status;

  return subscriptionRepository.updateSubscription(subscription.id, {
    status,
    billingStatus,
    accessStatus:
      paymentStatus === PAYMENT_STATUS.APPROVED
        ? SUBSCRIPTION_STATUS.ACTIVE
        : computeAccessStatus({
            ...subscription,
            status,
            billing_status: billingStatus,
            next_due_date: nextDueDate,
          }),
    nextDueDate,
    currentPeriodEnd: nextDueDate,
    graceUntil: computeGraceUntil({
      ...subscription,
      next_due_date: nextDueDate,
    }),
    lastPaymentAt: paidAt,
    blockReason: null,
  });
}

async function cancelSubscription(subscriptionId) {
  const subscription = await subscriptionRepository.findById(subscriptionId);
  if (!subscription) {
    return null;
  }

  if (subscription.mercado_pago_preapproval_id) {
    await mercadoPagoService.cancelPreapproval(subscription.mercado_pago_preapproval_id);
  }

  return subscriptionRepository.updateSubscription(subscription.id, {
    status: SUBSCRIPTION_STATUS.CANCELED,
    billingStatus: SUBSCRIPTION_STATUS.CANCELED,
    accessStatus: SUBSCRIPTION_STATUS.CANCELED,
    canceledAt: new Date().toISOString(),
    blockReason: 'Assinatura cancelada pelo Super Admin.',
  });
}

async function updateSubscriptionTerms(subscriptionId, payload) {
  const subscription = await subscriptionRepository.findById(subscriptionId);
  if (!subscription) {
    return null;
  }

  const nextDueDate = payload.nextDueDate || subscription.next_due_date;
  const extraGraceDays =
    payload.extraGraceDays === undefined ? subscription.extra_grace_days : Number(payload.extraGraceDays);
  const accessStatus = computeAccessStatus({
    ...subscription,
    next_due_date: nextDueDate,
    extra_grace_days: extraGraceDays,
  });

  if (payload.amountCents && subscription.mercado_pago_preapproval_id) {
    await mercadoPagoService.updatePreapproval(subscription.mercado_pago_preapproval_id, {
      auto_recurring: {
        transaction_amount: Number((payload.amountCents / 100).toFixed(2)),
        currency_id: 'BRL',
      },
    });
  }

  if (payload.amountCents) {
    await planRepository.updatePlanAmount(subscription.plano_id, payload.amountCents);
  }

  return subscriptionRepository.updateSubscription(subscriptionId, {
    nextDueDate,
    currentPeriodEnd: nextDueDate,
    extraGraceDays,
    accessStatus,
    graceUntil: computeGraceUntil({
      ...subscription,
      next_due_date: nextDueDate,
      extra_grace_days: extraGraceDays,
    }),
    blockReason: accessStatus === SUBSCRIPTION_STATUS.BLOCKED ? 'Bloqueado por atraso.' : null,
  });
}

module.exports = {
  getClientWorkspace,
  refreshSubscriptionStatus,
  syncSubscriptionFromMercadoPago,
  createRenewalLink,
  registerPaymentFromNotification,
  cancelSubscription,
  updateSubscriptionTerms,
};
