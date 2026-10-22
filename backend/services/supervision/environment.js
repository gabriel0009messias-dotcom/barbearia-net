const path = require('node:path');
const os = require('node:os');
const allowed = Object.freeze([
  'NODE_ENV','PORT','TZ','LANG','DATABASE_SCHEMA','LEGACY_DATABASE_SCHEMA',
  'RENDER','RENDER_SERVICE_ID','RENDER_INSTANCE_ID','RENDER_GIT_COMMIT','RENDER_EXTERNAL_URL',
  'PUBLIC_APP_URL','JWT_SECRET','LEGACY_ADMIN_EMAIL','LEGACY_ADMIN_PASSWORD','LEGACY_DEMO_EMAIL','LEGACY_DEMO_PASSWORD',
  'EVOLUTION_API_URL','EVOLUTION_API_KEY','EVOLUTION_WEBHOOK_SECRET','EVOLUTION_API_TIMEOUT_MS','EVOLUTION_API_RETRY_ATTEMPTS',
  'EVOLUTION_API_RETRY_DELAY_MS','EVOLUTION_ALWAYS_ONLINE','EVOLUTION_SYNC_FULL_HISTORY','EVOLUTION_READ_MESSAGES','EVOLUTION_READ_STATUS','EVOLUTION_STATUS_TRACE',
  'MERCADO_PAGO_ACCESS_TOKEN','MERCADO_PAGO_WEBHOOK_SECRET','MERCADO_PAGO_MODE',
  'RESEND_API_KEY','BREVO_API_KEY','EMAIL_FROM','EMAIL_FROM_NAME','EMAIL_CONNECTION_TIMEOUT','EMAIL_GREETING_TIMEOUT','EMAIL_SOCKET_TIMEOUT','EMAIL_SEND_TIMEOUT',
  'SMTP_HOST','SMTP_PORT','SMTP_SECURE','SMTP_USER','SMTP_PASS','SMTP_FROM',
  'GMAIL_USER','GMAIL_APP_PASSWORD','GMAIL_PORT','GMAIL_SECURE','GMAIL_FROM',
]);
const aliases = Object.freeze({ PUBLIC_APP_URL: ['APP_URL'], EVOLUTION_API_URL: ['WHATSAPP_EVOLUTION_API_URL'],
  EVOLUTION_API_KEY: ['WHATSAPP_EVOLUTION_API_KEY'], BREVO_API_KEY: ['SENDINBLUE_API_KEY'],
  LEGACY_ADMIN_EMAIL: ['ADMIN_EMAIL','SUPER_ADMIN_EMAIL'], LEGACY_ADMIN_PASSWORD: ['ADMIN_PASSWORD','SUPER_ADMIN_PASSWORD'] });
function executorEnvironment(source, { executorDatabaseUrl, home = os.tmpdir(), executable = process.execPath } = {}) {
  const env = Object.create(null);
  for (const name of allowed) {
    const value = source[name] || aliases[name]?.map(key => source[key]).find(Boolean);
    if (typeof value === 'string') env[name] = value;
  }
  // DATABASE_URL is never copied from the supervisor's general environment.
  if (executorDatabaseUrl !== undefined) {
    if (typeof executorDatabaseUrl !== 'string') throw Error('Invalid executor database URL.');
    env.DATABASE_URL = executorDatabaseUrl;
  }
  env.PATH = path.dirname(executable); env.HOME = home;
  return env;
}
module.exports = { executorEnvironment, allowed };
