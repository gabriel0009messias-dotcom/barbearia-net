const { query } = require('../database/pool');

async function create(payload) {
  const result = await query(
    `INSERT INTO salons (
      name, slug, owner_name, email, phone, opening_time, closing_time,
      lunch_start, lunch_end, working_days
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
    RETURNING *`,
    [
      payload.name,
      payload.slug,
      payload.ownerName,
      payload.email.toLowerCase(),
      payload.phone || null,
      payload.openingTime || '08:00',
      payload.closingTime || '18:00',
      payload.lunchStart || '12:00',
      payload.lunchEnd || '13:00',
      JSON.stringify(payload.workingDays || [1, 2, 3, 4, 5, 6]),
    ]
  );

  return result.rows[0];
}

async function findById(id) {
  const result = await query('SELECT * FROM salons WHERE id = $1 LIMIT 1', [id]);
  return result.rows[0] || null;
}

async function findBySlug(slug) {
  const result = await query('SELECT * FROM salons WHERE slug = $1 LIMIT 1', [slug]);
  return result.rows[0] || null;
}

async function findByEmail(email) {
  const result = await query('SELECT * FROM salons WHERE email = $1 LIMIT 1', [email.toLowerCase()]);
  return result.rows[0] || null;
}

module.exports = {
  create,
  findById,
  findBySlug,
  findByEmail,
};
