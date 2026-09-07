const { query } = require('../database/pool');

async function createClient({ companyName, ownerName, document, email, phone }) {
  const result = await query(
    `INSERT INTO clientes (nome_fantasia, responsavel_nome, documento, email, telefone, status)
     VALUES ($1, $2, $3, $4, $5, 'ativo')
     RETURNING *`,
    [companyName, ownerName, document || null, email.toLowerCase(), phone || null]
  );

  return result.rows[0];
}

async function findById(id) {
  const result = await query('SELECT * FROM clientes WHERE id = $1 LIMIT 1', [id]);
  return result.rows[0] || null;
}

async function updateClient(id, payload) {
  const result = await query(
    `UPDATE clientes
     SET nome_fantasia = $2,
         responsavel_nome = $3,
         documento = $4,
         telefone = $5,
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [id, payload.companyName, payload.ownerName, payload.document || null, payload.phone || null]
  );

  return result.rows[0] || null;
}

async function listClients({ status, accessStatus, search }) {
  const filters = [];
  const values = [];

  if (status) {
    values.push(status);
    filters.push(`s.status = $${values.length}`);
  }

  if (accessStatus) {
    values.push(accessStatus);
    filters.push(`s.access_status = $${values.length}`);
  }

  if (search) {
    values.push(`%${search.toLowerCase()}%`);
    filters.push(`(LOWER(c.nome_fantasia) LIKE $${values.length} OR LOWER(c.responsavel_nome) LIKE $${values.length} OR LOWER(c.email) LIKE $${values.length})`);
  }

  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const result = await query(
    `SELECT c.*, s.id AS subscription_id, s.status AS subscription_status, s.access_status, s.billing_status, s.next_due_date,
            s.grace_until, s.extra_grace_days, p.nome AS plan_name, p.valor_centavos
     FROM clientes c
     LEFT JOIN assinaturas s ON s.cliente_id = c.id
     LEFT JOIN planos p ON p.id = s.plano_id
     ${where}
     ORDER BY c.created_at DESC`,
    values
  );

  return result.rows;
}

module.exports = {
  createClient,
  findById,
  updateClient,
  listClients,
};
