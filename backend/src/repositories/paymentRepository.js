const { query } = require('../database/pool');

async function createOrUpdatePayment(payload) {
  const result = await query(
    `INSERT INTO pagamentos (
      cliente_id, assinatura_id, mercado_pago_payment_id, mercado_pago_authorized_payment_id,
      status, status_detail, valor_centavos, moeda, due_date, paid_at, payload
    ) VALUES (
      $1, $2, $3, $4,
      $5, $6, $7, $8, $9, $10, $11::jsonb
    )
    ON CONFLICT (mercado_pago_payment_id)
    DO UPDATE SET
      mercado_pago_authorized_payment_id = EXCLUDED.mercado_pago_authorized_payment_id,
      status = EXCLUDED.status,
      status_detail = EXCLUDED.status_detail,
      valor_centavos = EXCLUDED.valor_centavos,
      moeda = EXCLUDED.moeda,
      due_date = EXCLUDED.due_date,
      paid_at = EXCLUDED.paid_at,
      payload = EXCLUDED.payload
    RETURNING *`,
    [
      payload.clientId,
      payload.subscriptionId,
      payload.paymentId || null,
      payload.authorizedPaymentId || null,
      payload.status,
      payload.statusDetail || null,
      payload.amountCents,
      payload.currency || 'BRL',
      payload.dueDate || null,
      payload.paidAt || null,
      JSON.stringify(payload.raw || {}),
    ]
  );

  return result.rows[0];
}

async function listBySubscriptionId(subscriptionId) {
  const result = await query(
    'SELECT * FROM pagamentos WHERE assinatura_id = $1 ORDER BY COALESCE(paid_at, created_at) DESC',
    [subscriptionId]
  );

  return result.rows;
}

async function getRevenueSummary() {
  const result = await query(
    `SELECT
      COALESCE(SUM(CASE WHEN status = 'approved' AND DATE_TRUNC('month', COALESCE(paid_at, created_at)) = DATE_TRUNC('month', NOW()) THEN valor_centavos END), 0) AS month_revenue,
      COALESCE(SUM(CASE WHEN status = 'approved' AND DATE_TRUNC('year', COALESCE(paid_at, created_at)) = DATE_TRUNC('year', NOW()) THEN valor_centavos END), 0) AS year_revenue
     FROM pagamentos`
  );

  return result.rows[0];
}

async function listRecentPayments(limit = 10) {
  const result = await query(
    `SELECT p.*, c.nome_fantasia
     FROM pagamentos p
     JOIN clientes c ON c.id = p.cliente_id
     ORDER BY COALESCE(p.paid_at, p.created_at) DESC
     LIMIT $1`,
    [limit]
  );

  return result.rows;
}

module.exports = {
  createOrUpdatePayment,
  listBySubscriptionId,
  getRevenueSummary,
  listRecentPayments,
};
