const ROLES = {
  SUPER_ADMIN: 'super_admin',
  CLIENT: 'client',
};

const SUBSCRIPTION_STATUS = {
  PENDING: 'pending',
  AUTHORIZED: 'authorized',
  ACTIVE: 'active',
  PAST_DUE: 'past_due',
  GRACE: 'grace',
  BLOCKED: 'blocked',
  CANCELED: 'canceled',
};

const PAYMENT_STATUS = {
  APPROVED: 'approved',
  PENDING: 'pending',
  IN_PROCESS: 'in_process',
  REJECTED: 'rejected',
  CANCELED: 'cancelled',
  REFUNDED: 'refunded',
};

const LOG_LEVELS = {
  INFO: 'info',
  WARN: 'warn',
  ERROR: 'error',
};

module.exports = {
  ROLES,
  SUBSCRIPTION_STATUS,
  PAYMENT_STATUS,
  LOG_LEVELS,
};
