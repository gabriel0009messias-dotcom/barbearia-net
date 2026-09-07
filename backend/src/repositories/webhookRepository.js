const { query } = require('../database/pool');

async function createWebhookLog(payload) {
  const result = await query(
    `INSERT INTO webhooks (topico, acao, recurso_id, assinatura, status, payload)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     RETURNING *`,
    [payload.topic, payload.action || null, payload.resourceId || null, payload.signature || null, payload.status || 'received', JSON.stringify(payload.raw || {})]
  );

  return result.rows[0];
}

async function markWebhookProcessed(id, status, errorMessage = null) {
  await query(
    'UPDATE webhooks SET status = $2, erro = $3, processed_at = NOW() WHERE id = $1',
    [id, status, errorMessage]
  );
}

module.exports = {
  createWebhookLog,
  markWebhookProcessed,
};
