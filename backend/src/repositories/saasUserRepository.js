const { query } = require('../database/pool');

async function findByEmail(email) {
  const result = await query('SELECT * FROM users WHERE email = $1 LIMIT 1', [email.toLowerCase()]);
  return result.rows[0] || null;
}

async function findById(id) {
  const result = await query('SELECT * FROM users WHERE id = $1 LIMIT 1', [id]);
  return result.rows[0] || null;
}

async function create(payload) {
  const result = await query(
    `INSERT INTO users (salon_id, name, email, password_hash, role)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [payload.salonId, payload.name, payload.email.toLowerCase(), payload.passwordHash, payload.role]
  );

  return result.rows[0];
}

module.exports = {
  findByEmail,
  findById,
  create,
};
