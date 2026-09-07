const { query } = require('../database/pool');

async function create(payload) {
  const result = await query(
    `INSERT INTO subscriptions (
      salon_id, status, amount, provider, provider_reference, checkout_url,
      start_date, next_payment_date
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING *`,
    [
      payload.salonId,
      payload.status,
      payload.amount,
      payload.provider || 'MERCADO_PAGO',
      payload.providerReference || null,
      payload.checkoutUrl || null,
      payload.startDate,
      payload.nextPaymentDate,
    ]
  );

  return result.rows[0];
}

async function findBySalonId(salonId) {
  const result = await query(
    'SELECT * FROM subscriptions WHERE salon_id = $1 ORDER BY created_at DESC LIMIT 1',
    [salonId]
  );
  return result.rows[0] || null;
}

async function updateBySalonId(salonId, payload) {
  const result = await query(
    `UPDATE subscriptions
     SET status = COALESCE($2, status),
         amount = COALESCE($3, amount),
         provider_reference = COALESCE($4, provider_reference),
         checkout_url = COALESCE($5, checkout_url),
         next_payment_date = COALESCE($6, next_payment_date),
         updated_at = NOW()
     WHERE salon_id = $1
     RETURNING *`,
    [salonId, payload.status ?? null, payload.amount ?? null, payload.providerReference ?? null, payload.checkoutUrl ?? null, payload.nextPaymentDate ?? null]
  );

  return result.rows[0] || null;
}

module.exports = {
  create,
  findBySalonId,
  updateBySalonId,
};
