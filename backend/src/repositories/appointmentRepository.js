const { query } = require('../database/pool');

async function listBySalonId(salonId, filters = {}) {
  const values = [salonId];
  const clauses = ['a.salon_id = $1'];

  if (filters.date) {
    values.push(filters.date);
    clauses.push(`a.date = $${values.length}`);
  }

  if (filters.status) {
    values.push(filters.status);
    clauses.push(`a.status = $${values.length}`);
  }

  const result = await query(
    `SELECT a.*, c.name AS client_name, p.name AS professional_name, s.name AS service_name
     FROM appointments a
     JOIN clients c ON c.id = a.client_id
     JOIN professionals p ON p.id = a.professional_id
     JOIN services s ON s.id = a.service_id
     WHERE ${clauses.join(' AND ')}
     ORDER BY a.date ASC, a.start_time ASC`,
    values
  );

  return result.rows;
}

async function findById(salonId, id) {
  const result = await query('SELECT * FROM appointments WHERE salon_id = $1 AND id = $2 LIMIT 1', [salonId, id]);
  return result.rows[0] || null;
}

async function findConflicts(salonId, payload, ignoreId = null) {
  const values = [salonId, payload.professionalId, payload.date, payload.startTime, payload.endTime];
  let sql =
    `SELECT id
     FROM appointments
     WHERE salon_id = $1
       AND professional_id = $2
       AND date = $3
       AND status IN ('PENDING', 'CONFIRMED', 'COMPLETED')
       AND start_time < $5
       AND end_time > $4`;

  if (ignoreId) {
    values.push(ignoreId);
    sql += ` AND id <> $${values.length}`;
  }

  const result = await query(sql, values);
  return result.rows;
}

async function create(salonId, payload) {
  const result = await query(
    `INSERT INTO appointments (
      salon_id, client_id, professional_id, service_id, date, start_time, end_time, status, notes
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    RETURNING *`,
    [
      salonId,
      payload.clientId,
      payload.professionalId,
      payload.serviceId,
      payload.date,
      payload.startTime,
      payload.endTime,
      payload.status,
      payload.notes || null,
    ]
  );

  return result.rows[0];
}

async function update(salonId, id, payload) {
  const result = await query(
    `UPDATE appointments
     SET client_id = $3,
         professional_id = $4,
         service_id = $5,
         date = $6,
         start_time = $7,
         end_time = $8,
         status = $9,
         notes = $10,
         updated_at = NOW()
     WHERE salon_id = $1 AND id = $2
     RETURNING *`,
    [
      salonId,
      id,
      payload.clientId,
      payload.professionalId,
      payload.serviceId,
      payload.date,
      payload.startTime,
      payload.endTime,
      payload.status,
      payload.notes || null,
    ]
  );

  return result.rows[0] || null;
}

async function cancel(salonId, id) {
  const result = await query(
    `UPDATE appointments
     SET status = 'CANCELLED',
         updated_at = NOW()
     WHERE salon_id = $1 AND id = $2
     RETURNING *`,
    [salonId, id]
  );

  return result.rows[0] || null;
}

module.exports = {
  listBySalonId,
  findById,
  findConflicts,
  create,
  update,
  cancel,
};
