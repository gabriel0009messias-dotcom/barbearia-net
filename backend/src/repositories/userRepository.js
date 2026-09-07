const { query } = require('../database/pool');

async function findByEmail(email) {
  const result = await query('SELECT * FROM usuarios WHERE email = $1 LIMIT 1', [email.toLowerCase()]);
  return result.rows[0] || null;
}

async function findById(id) {
  const result = await query('SELECT * FROM usuarios WHERE id = $1 LIMIT 1', [id]);
  return result.rows[0] || null;
}

async function createClientUser({ clientId, name, email, phone, passwordHash, role }) {
  const result = await query(
    `INSERT INTO usuarios (cliente_id, nome, email, telefone, senha_hash, papel, ativo)
     VALUES ($1, $2, $3, $4, $5, $6, TRUE)
     RETURNING *`,
    [clientId, name, email.toLowerCase(), phone || null, passwordHash, role]
  );

  return result.rows[0];
}

async function updateLastLogin(id) {
  await query('UPDATE usuarios SET ultimo_login_at = NOW(), updated_at = NOW() WHERE id = $1', [id]);
}

async function updatePassword(id, passwordHash) {
  await query('UPDATE usuarios SET senha_hash = $2, updated_at = NOW() WHERE id = $1', [id, passwordHash]);
}

module.exports = {
  findByEmail,
  findById,
  createClientUser,
  updateLastLogin,
  updatePassword,
};
