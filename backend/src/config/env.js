const path = require('path');

require(path.join(__dirname, '..', '..', 'loadEnv'));

function toNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toBoolean(value, fallback = false) {
  if (value === undefined) {
    return fallback;
  }

  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: toNumber(process.env.PORT, 3000),
  appUrl: process.env.APP_URL || 'http://localhost:3000',
  corsOrigin: process.env.CORS_ORIGIN || process.env.FRONTEND_URL || '*',
  databaseUrl: process.env.DATABASE_URL || '',
  jwtSecret: process.env.JWT_SECRET || 'change-me-in-production',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '12h',
  mercadoPagoAccessToken: process.env.MERCADO_PAGO_ACCESS_TOKEN || '',
  mercadoPagoWebhookSecret: process.env.MERCADO_PAGO_WEBHOOK_SECRET || '',
  mercadoPagoBaseUrl: process.env.MERCADO_PAGO_BASE_URL || 'https://api.mercadopago.com',
  evolutionApiUrl: process.env.EVOLUTION_API_URL || '',
  evolutionApiKey: process.env.EVOLUTION_API_KEY || '',
  // Instancias gratuitas podem ficar inativas e levar algum tempo para acordar.
  // Estes valores podem ser ajustados no ambiente sem alterar o codigo.
  evolutionApiTimeoutMs: toNumber(process.env.EVOLUTION_API_TIMEOUT_MS, 90000),
  evolutionApiRetryAttempts: toNumber(process.env.EVOLUTION_API_RETRY_ATTEMPTS, 3),
  evolutionApiRetryDelayMs: toNumber(process.env.EVOLUTION_API_RETRY_DELAY_MS, 3000),
  superAdminName: process.env.SUPER_ADMIN_NAME || 'Super Admin',
  superAdminEmail: process.env.SUPER_ADMIN_EMAIL || 'admin@barbearia.local',
  superAdminPassword: process.env.SUPER_ADMIN_PASSWORD || 'Admin@123456',
  superAdminPhone: process.env.SUPER_ADMIN_PHONE || '',
  defaultPlanAmountCents: toNumber(process.env.DEFAULT_PLAN_AMOUNT_CENTS, 6500),
  defaultPlanName: process.env.DEFAULT_PLAN_NAME || 'Plano Mensal SaaS',
  graceDays: toNumber(process.env.GRACE_DAYS, 4),
  statusSyncIntervalMinutes: toNumber(process.env.STATUS_SYNC_INTERVAL_MINUTES, 60),
  enableDocsWarning: toBoolean(process.env.ENABLE_DOCS_WARNING, true),
};

function validateEnv() {
  const requiredForStartup = [];
  const optionalModules = [];

  if (!env.databaseUrl) {
    requiredForStartup.push('DATABASE_URL');
  }

  if (!env.jwtSecret || env.jwtSecret === 'change-me-in-production') {
    requiredForStartup.push('JWT_SECRET');
  }

  if (!env.mercadoPagoAccessToken) {
    optionalModules.push('MERCADO_PAGO_ACCESS_TOKEN');
  }

  if (requiredForStartup.length && env.enableDocsWarning) {
    console.warn(`[env] Variaveis obrigatorias para iniciar o backend: ${requiredForStartup.join(', ')}`);
  }

  if (optionalModules.length && env.enableDocsWarning) {
    console.warn(
      `[env] Variaveis opcionais nesta etapa, necessarias apenas para modulos especificos: ${optionalModules.join(', ')}`
    );
  }
}

validateEnv();

module.exports = env;
