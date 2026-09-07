const { query } = require('../database/pool');

async function listBySalonId(salonId) {
  const result = await query('SELECT * FROM services WHERE salon_id = $1 ORDER BY created_at DESC', [salonId]);
  return result.rows;
}

async function findById(salonId, id) {
  const result = await query('SELECT * FROM services WHERE salon_id = $1 AND id = $2 LIMIT 1', [salonId, id]);
  return result.rows[0] || null;
}

async function create(salonId, payload) {
  const result = await query(
    `INSERT INTO services (salon_id, name, description, price, duration_minutes, active)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [salonId, payload.name, payload.description || null, payload.price, payload.durationMinutes, payload.active ?? true]
  );

  return result.rows[0];
}

async function update(salonId, id, payload) {
  const result = await query(
    `UPDATE services
     SET name = $3,
         description = $4,
         price = $5,
         duration_minutes = $6,
         active = $7,
         updated_at = NOW()
     WHERE salon_id = $1 AND id = $2
     RETURNING *`,
    [salonId, id, payload.name, payload.description || null, payload.price, payload.durationMinutes, payload.active ?? true]
  );

  return result.rows[0] || null;
}

async function remove(salonId, id) {
  await query('DELETE FROM services WHERE salon_id = $1 AND id = $2', [salonId, id]);
}

module.exports = {
  listBySalonId,
  findById,
  create,
  update,
  remove,
};
