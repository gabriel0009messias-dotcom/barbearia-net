const crypto = require('node:crypto');
const TRIAL_MS = 7 * 24 * 60 * 60 * 1000;
function trialState(account, now = Date.now()) {
  if (!account?.trial_status) return { status: 'unavailable', daysRemaining: 0 };
  const started = Date.parse(account.trial_started_at), ends = new Date(account.trial_ends_at).getTime();
  const valid = Number.isFinite(started) && Number.isFinite(ends) && ends - started === TRIAL_MS;
  const converted = account.trial_status === 'converted' || Boolean(account.ultimo_pagamento || account.payment_id);
  const active = !converted && account.trial_status === 'active' && valid && now >= started && now < ends;
  return { status: converted ? 'converted' : active ? 'active' : 'expired',
    startedAt: valid ? new Date(started).toISOString() : null,
    endsAt: valid ? new Date(ends).toISOString() : null,
    daysRemaining: active ? Math.ceil((ends - now) / 86400000) : 0 };
}
function normalizePhone(value) {
  let phone = String(value || '').replace(/\D/g, '');
  if (phone.length === 12 || phone.length === 13) { if (phone.startsWith('55')) phone = phone.slice(2); }
  return phone;
}
function identities(body) {
  const email = String(body.email || '').trim().toLowerCase();
  const phones = [...new Set([normalizePhone(body.telefone), normalizePhone(body.whatsappNumero || body.telefone)])];
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || phones.some(p => !/^\d{10,11}$/.test(p))) {
    throw Object.assign(new Error('Informe e-mail e telefones válidos, com DDD.'), { statusCode: 400 });
  }
  return { email, phones, hashes: ['email:' + email, ...phones.map(p => 'phone:' + p)].map(value => crypto.createHash('sha256').update(value).digest('hex')).sort() };
}
async function startTrial(connection, id, keys) {
  for (const hash of keys.hashes) {
    const result = await connection.runAsync('INSERT INTO trial_claims (identity_hash) VALUES ($1) ON CONFLICT DO NOTHING', [hash]);
    if (!result.changes) throw Object.assign(new Error('Estes dados já utilizaram o teste grátis. Entre na sua conta para assinar.'), { statusCode: 409 });
  }
  // Database clock, captured once; interval is 168 hours even across DST changes.
  const result = await connection.runAsync(`WITH moment AS (SELECT clock_timestamp() AS at)
    UPDATE assinaturas SET trial_started_at = to_char(moment.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      trial_ends_at = date_trunc('milliseconds', moment.at) + interval '168 hours',
      trial_status = 'active', trial_usado = 1, trial = 1
    FROM moment WHERE id = $1 AND trial_status IS NULL AND trial_started_at IS NULL AND trial_usado = 0`, [id]);
  if (result.changes !== 1) throw new Error('Trial somente pode ser iniciado uma vez, em uma conta nova.');
}
// Billing access is evaluated first, preserving existing subscriptions and grace periods.
function accessState(account, billing, now = Date.now()) {
  const trial = trialState(account, now);
  if (billing.liberado) return { ...billing, status: 'subscription_active', trial };
  const blocked = Number(account?.bloqueado) === 1 || ['bloqueada', 'cancelada'].includes(account?.status);
  if (!blocked && trial.status === 'active') return { liberado: true, status: 'trial_active', motivo: 'trial_active', mensagem: 'Teste grátis ativo.', trial };
  if (trial.status === 'expired') return { liberado: false, status: 'trial_expired', motivo: 'trial_expired', mensagem: 'Seu teste grátis terminou. Seus dados continuam salvos.', trial };
  return { ...billing, status: 'payment_required', trial };
}
module.exports = { TRIAL_MS, trialState, normalizePhone, identities, startTrial, accessState };
