const { query } = require('../database/pool');

async function listBySalonId(salonId, date) {
  const values = [salonId];
  let sql = 'SELECT * FROM blocked_times WHERE salon_id = $1';

  if (date) {
    values.push(date);
    sql += ` AND date = $${values.length}`;
  }

  sql += ' ORDER BY date, start_time';
  const result = await query(sql, values);
  return result.rows;
}

async function create(salonId, payload) {
  const result = await query(
    `INSERT INTO blocked_times (salon_id, professional_id, date, start_time, end_time, reason)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [salonId, payload.professionalId || null, payload.date, payload.startTime, payload.endTime, payload.reason || null]
  );

  return result.rows[0];
}

async function remove(salonId, id) {
  await query('DELETE FROM blocked_times WHERE salon_id = $1 AND id = $2', [salonId, id]);
}

module.exports = {
  listBySalonId,
  create,
  remove,
};
