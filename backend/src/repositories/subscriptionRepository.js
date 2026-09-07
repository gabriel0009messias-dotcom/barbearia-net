const { query } = require('../database/pool');

async function createSubscription(payload) {
  const result = await query(
    `INSERT INTO assinaturas (
      cliente_id, plano_id, referencia_externa, mercado_pago_preapproval_id, mercado_pago_checkout_url,
      status, billing_status, access_status, dia_vencimento, grace_days, extra_grace_days,
      current_period_start, current_period_end, next_due_date, grace_until, metadata
    ) VALUES (
      $1, $2, $3, $4, $5,
      $6, $7, $8, $9, $10, $11,
      $12, $13, $14, $15, $16::jsonb
    )
    RETURNING *`,
    [
      payload.clientId,
      payload.planId,
      payload.externalReference,
      payload.mercadoPagoPreapprovalId || null,
      payload.checkoutUrl || null,
      payload.status,
      payload.billingStatus,
      payload.accessStatus,
      payload.dueDay || null,
      payload.graceDays,
      payload.extraGraceDays || 0,
      payload.currentPeriodStart || null,
      payload.currentPeriodEnd || null,
      payload.nextDueDate || null,
      payload.graceUntil || null,
      JSON.stringify(payload.metadata || {}),
    ]
  );

  return result.rows[0];
}

async function findById(id) {
  const result = await query(
    `SELECT s.*, c.nome_fantasia, c.responsavel_nome, c.email, c.telefone, p.nome AS plan_name, p.valor_centavos
     FROM assinaturas s
     JOIN clientes c ON c.id = s.cliente_id
     JOIN planos p ON p.id = s.plano_id
     WHERE s.id = $1
     LIMIT 1`,
    [id]
  );

  return result.rows[0] || null;
}

async function findByClientId(clientId) {
  const result = await query(
    `SELECT s.*, p.nome AS plan_name, p.valor_centavos
     FROM assinaturas s
     JOIN planos p ON p.id = s.plano_id
     WHERE s.cliente_id = $1
     ORDER BY s.created_at DESC
     LIMIT 1`,
    [clientId]
  );

  return result.rows[0] || null;
}

async function findByPreapprovalId(preapprovalId) {
  const result = await query('SELECT * FROM assinaturas WHERE mercado_pago_preapproval_id = $1 LIMIT 1', [preapprovalId]);
  return result.rows[0] || null;
}

async function findByExternalReference(externalReference) {
  const result = await query('SELECT * FROM assinaturas WHERE referencia_externa = $1 LIMIT 1', [externalReference]);
  return result.rows[0] || null;
}

async function updateSubscription(id, payload) {
  const result = await query(
    `UPDATE assinaturas
     SET mercado_pago_preapproval_id = COALESCE($2, mercado_pago_preapproval_id),
         mercado_pago_checkout_url = COALESCE($3, mercado_pago_checkout_url),
         status = COALESCE($4, status),
         billing_status = COALESCE($5, billing_status),
         access_status = COALESCE($6, access_status),
         dia_vencimento = COALESCE($7, dia_vencimento),
         grace_days = COALESCE($8, grace_days),
         extra_grace_days = COALESCE($9, extra_grace_days),
         current_period_start = COALESCE($10, current_period_start),
         current_period_end = COALESCE($11, current_period_end),
         next_due_date = COALESCE($12, next_due_date),
         grace_until = COALESCE($13, grace_until),
         last_payment_at = COALESCE($14, last_payment_at),
         canceled_at = COALESCE($15, canceled_at),
         block_reason = $16,
         metadata = COALESCE($17::jsonb, metadata),
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [
      id,
      payload.mercadoPagoPreapprovalId ?? null,
      payload.checkoutUrl ?? null,
      payload.status ?? null,
      payload.billingStatus ?? null,
      payload.accessStatus ?? null,
      payload.dueDay ?? null,
      payload.graceDays ?? null,
      payload.extraGraceDays ?? null,
      payload.currentPeriodStart ?? null,
      payload.currentPeriodEnd ?? null,
      payload.nextDueDate ?? null,
      payload.graceUntil ?? null,
      payload.lastPaymentAt ?? null,
      payload.canceledAt ?? null,
      payload.blockReason ?? null,
      payload.metadata ? JSON.stringify(payload.metadata) : null,
    ]
  );

  return result.rows[0] || null;
}

async function listSubscriptionsForStatusSync() {
  const result = await query('SELECT * FROM assinaturas WHERE canceled_at IS NULL');
  return result.rows;
}

module.exports = {
  createSubscription,
  findById,
  findByClientId,
  findByPreapprovalId,
  findByExternalReference,
  updateSubscription,
  listSubscriptionsForStatusSync,
};
