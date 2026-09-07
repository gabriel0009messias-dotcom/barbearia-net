const { SUBSCRIPTION_STATUS } = require('../config/constants');
const { addDays, daysBetween, parseIsoDate, startOfDay, toIsoDate } = require('./date');

function computeAccessStatus(subscription, now = new Date()) {
  if (!subscription) {
    return SUBSCRIPTION_STATUS.BLOCKED;
  }

  if (subscription.status === SUBSCRIPTION_STATUS.CANCELED) {
    return SUBSCRIPTION_STATUS.CANCELED;
  }

  if (subscription.status === SUBSCRIPTION_STATUS.BLOCKED) {
    return SUBSCRIPTION_STATUS.BLOCKED;
  }

  const nextDueDate = parseIsoDate(subscription.next_due_date || subscription.nextDueDate);

  if (!nextDueDate) {
    return SUBSCRIPTION_STATUS.PENDING;
  }

  const today = startOfDay(now);
  const dueDate = startOfDay(nextDueDate);
  const diff = daysBetween(dueDate, today);
  const graceDays = Number(subscription.grace_days ?? subscription.graceDays ?? 4);
  const extraGraceDays = Number(subscription.extra_grace_days ?? subscription.extraGraceDays ?? 0);
  const totalGrace = graceDays + extraGraceDays;

  if (diff <= 0) {
    if (subscription.billing_status === SUBSCRIPTION_STATUS.PENDING || subscription.status === SUBSCRIPTION_STATUS.PENDING) {
      return SUBSCRIPTION_STATUS.PENDING;
    }

    return SUBSCRIPTION_STATUS.ACTIVE;
  }

  if (diff <= totalGrace) {
    return SUBSCRIPTION_STATUS.GRACE;
  }

  return SUBSCRIPTION_STATUS.BLOCKED;
}

function computeGraceUntil(subscription) {
  const nextDueDate = parseIsoDate(subscription.next_due_date || subscription.nextDueDate);
  if (!nextDueDate) {
    return null;
  }

  const graceDays = Number(subscription.grace_days ?? subscription.graceDays ?? 4);
  const extraGraceDays = Number(subscription.extra_grace_days ?? subscription.extraGraceDays ?? 0);
  return toIsoDate(addDays(nextDueDate, graceDays + extraGraceDays));
}

module.exports = {
  computeAccessStatus,
  computeGraceUntil,
};
