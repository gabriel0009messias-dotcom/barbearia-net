const { query } = require('../database/pool');

async function listBySalonId(salonId) {
  const result = await query('SELECT * FROM clients WHERE salon_id = $1 ORDER BY created_at DESC', [salonId]);
  return result.rows;
}

async function findById(salonId, id) {
  const result = await query('SELECT * FROM clients WHERE salon_id = $1 AND id = $2 LIMIT 1', [salonId, id]);
  return result.rows[0] || null;
}

async function create(salonId, payload) {
  const result = await query(
    `INSERT INTO clients (salon_id, name, phone, email, notes)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [salonId, payload.name, payload.phone || null, payload.email?.toLowerCase() || null, payload.notes || null]
  );

  return result.rows[0];
}

async function update(salonId, id, payload) {
  const result = await query(
    `UPDATE clients
     SET name = $3,
         phone = $4,
         email = $5,
         notes = $6,
         updated_at = NOW()
     WHERE salon_id = $1 AND id = $2
     RETURNING *`,
    [salonId, id, payload.name, payload.phone || null, payload.email?.toLowerCase() || null, payload.notes || null]
  );

  return result.rows[0] || null;
}

async function remove(salonId, id) {
  await query('DELETE FROM clients WHERE salon_id = $1 AND id = $2', [salonId, id]);
}

module.exports = {
  listBySalonId,
  findById,
  create,
  update,
  remove,
};
