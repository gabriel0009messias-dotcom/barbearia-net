// Diagnostics never create preferences, payments or database records.
function redact(value, key = '') {
  if (/token|secret|password|authorization|cookie|email|identification|phone|address|first_name|last_name|surname|nickname|card_number|security_code|^name$/i.test(key)) return '[REDACTED]';
  if (Array.isArray(value)) return value.map(item => redact(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redact(item, name)]));
  if (typeof value !== 'string') return value;
  let text = value;
  for (const secret of [process.env.MERCADO_PAGO_ACCESS_TOKEN, process.env.MERCADO_PAGO_WEBHOOK_SECRET]) {
    if (secret?.trim()) text = text.split(secret.trim()).join('[REDACTED]');
  }
  return text.replace(/(?:APP_USR|TEST)-[\w-]+/g, '[REDACTED]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[REDACTED]');
}

async function read(path) {
  try {
    const response = await fetch(`https://api.mercadopago.com${path}`, {
      method: 'GET', headers: { Authorization: `Bearer ${process.env.MERCADO_PAGO_ACCESS_TOKEN.trim()}` },
      signal: AbortSignal.timeout(15000),
    });
    return { status: response.status, requestId: response.headers.get('x-request-id'),
      body: await response.json().catch(() => ({ error: 'non_json_response' })) };
  } catch { return { status: null, body: { error: 'connection_failed' } }; }
}

async function diagnose(order) {
  if (!process.env.MERCADO_PAGO_ACCESS_TOKEN?.trim()) return { error: 'Access Token nao configurado.' };
  const [preference, seller, methods] = await Promise.all([
    read(`/checkout/preferences/${encodeURIComponent(order.preference_id)}`), read('/users/me'), read('/v1/payment_methods'),
  ]);
  const data = preference.body;
  const account = seller.body;
  const sameEmail = email => typeof email === 'string' && typeof account.email === 'string'
    ? email.trim().toLowerCase() === account.email.trim().toLowerCase() : null;
  return redact({
    checkedAt: new Date().toISOString(), mode: process.env.MERCADO_PAGO_MODE || 'production',
    webhookConfigured: Boolean(process.env.MERCADO_PAGO_WEBHOOK_SECRET?.trim()),
    publicAppUrl: process.env.PUBLIC_APP_URL || process.env.RENDER_EXTERNAL_URL || null,
    order: { preferenceId: order.preference_id, amountCents: order.amount_cents, liveMode: Boolean(order.live_mode), expiresAt: order.expires_at },
    checks: {
      collectorMatchesCredential: data.collector_id != null && account.id != null ? String(data.collector_id) === String(account.id) : null,
      payerMatchesSeller: sameEmail(data.payer?.email), subscriptionMatchesSeller: sameEmail(order.email),
      sellerIsTestUser: Array.isArray(account.tags) ? account.tags.includes('test_user') : null,
      expired: data.expires === true ? Date.parse(data.expiration_date_to) <= Date.now() : false,
      referenceMatches: data.external_reference != null ? data.external_reference === order.reference : null,
    },
    preference,
    seller: { status: seller.status, requestId: seller.requestId, body: {
      id: account.id, site_id: account.site_id, country_id: account.country_id,
      tags: account.tags, status: account.status, error: account.error, message: account.message,
    } },
    methods: { status: methods.status, requestId: methods.requestId, body: Array.isArray(methods.body)
      ? methods.body.map(({ id, payment_type_id, status, min_allowed_amount, max_allowed_amount }) => ({ id, payment_type_id, status, min_allowed_amount, max_allowed_amount }))
      : methods.body },
  });
}

module.exports = { redact, diagnose };
