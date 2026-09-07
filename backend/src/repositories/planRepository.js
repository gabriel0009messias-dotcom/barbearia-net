const { query } = require('../database/pool');

async function getDefaultPlan() {
  const result = await query('SELECT * FROM planos WHERE codigo = $1 LIMIT 1', ['plano-mensal']);
  return result.rows[0] || null;
}

async function updatePlanAmount(planId, amountCents) {
  const result = await query(
    'UPDATE planos SET valor_centavos = $2, updated_at = NOW() WHERE id = $1 RETURNING *',
    [planId, amountCents]
  );

  return result.rows[0] || null;
}

module.exports = {
  getDefaultPlan,
  updatePlanAmount,
};
